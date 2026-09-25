interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Runtime helpers for packs that wrap government open-data platforms.
 *
 * Socrata (SODA), CKAN, and ArcGIS FeatureServer/MapServer between them back a large share
 * of US state and municipal data, and every pack over them re-implements the same fetch,
 * timeout, retry, and shaping code. These helpers are deliberately small and dependency-free
 * so `scripts/publish-pack.sh` can inline them into a standalone published pack.
 *
 * State agency servers are slow and occasionally hostile: expect stalls, WAF interstitials
 * served with a 200 or 403, and columns whose names disagree between two datasets on the same
 * portal. `govFetchJson` therefore retries once by default and raises a message the caller can
 * turn into a `{ found: false, reason, hint }` rather than a bare throw.
 */

const DEFAULT_UA = 'pipeworx-mcp/1.0 (+https://pipeworx.io)';
const DEFAULT_TIMEOUT_MS = 15_000;

interface GovFetchOpts {
  /** Sent as Accept; defaults to application/json. */
  accept?: string;
  /** Socrata app token, sent as X-App-Token. Public endpoints work without one. */
  appToken?: string;
  /** Per-attempt budget. State ArcGIS servers routinely need >12s under load. */
  timeoutMs?: number;
  /** Extra attempts after the first. Defaults to 1. */
  retries?: number;
  userAgent?: string;
}

async function govFetchText(url: string, opts: GovFetchOpts = {}): Promise<string> {
  const retries = opts.retries ?? 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const headers: Record<string, string> = {
        'User-Agent': opts.userAgent ?? DEFAULT_UA,
        Accept: opts.accept ?? 'application/json',
      };
      if (opts.appToken) headers['X-App-Token'] = opts.appToken;
      const res = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`upstream ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
      }
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function govFetchJson<T = unknown>(url: string, opts: GovFetchOpts = {}): Promise<T> {
  const text = await govFetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch {
    // A WAF interstitial arrives as HTML on the JSON path; say so plainly, because the
    // alternative reads to a caller as our own parsing bug.
    const looksLikeChallenge = /<html|just a moment|captcha/i.test(text.slice(0, 400));
    throw new Error(
      looksLikeChallenge
        ? `upstream returned an HTML challenge page instead of JSON (${text.slice(0, 90).replace(/\s+/g, ' ')})`
        : `upstream returned non-JSON (${text.slice(0, 120)})`,
    );
  }
}

// ── Socrata (SODA 2.x) ──────────────────────────────────────────────

interface SoqlQuery {
  select?: string;
  where?: string;
  group?: string;
  order?: string;
  limit?: number;
  offset?: number;
}

/** Escape a value for interpolation into a SoQL string literal. */
function soqlEscape(v: string): string {
  return v.replace(/'/g, "''");
}

function soqlUrl(domain: string, resource: string, q: SoqlQuery): string {
  const p = new URLSearchParams();
  if (q.select) p.set('$select', q.select);
  if (q.where) p.set('$where', q.where);
  if (q.group) p.set('$group', q.group);
  if (q.order) p.set('$order', q.order);
  p.set('$limit', String(q.limit ?? 1000));
  if (q.offset) p.set('$offset', String(q.offset));
  return `https://${domain}/resource/${resource}.json?${p.toString()}`;
}

async function soqlRows<T = Record<string, string>>(
  domain: string,
  resource: string,
  q: SoqlQuery,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  return govFetchJson<T[]>(soqlUrl(domain, resource, q), opts);
}

/**
 * A Socrata dataset's last row update, as YYYY-MM-DD, for an `as_of` field. Best-effort:
 * resolves to null rather than failing a call that otherwise has data.
 */
async function soqlUpdatedAt(
  domain: string,
  resource: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const meta = await govFetchJson<{ rowsUpdatedAt?: number }>(
      `https://${domain}/api/views/${resource}.json`,
      { ...opts, retries: 0 },
    );
    return meta.rowsUpdatedAt ? new Date(meta.rowsUpdatedAt * 1000).toISOString().slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** Largest value of a column, e.g. the latest `year_month` a dataset carries. */
async function soqlMax(
  domain: string,
  resource: string,
  column: string,
  opts: GovFetchOpts = {},
): Promise<string | null> {
  try {
    const rows = await soqlRows<Record<string, string>>(
      domain,
      resource,
      { select: `max(${column}) as mx` },
      opts,
    );
    return rows[0]?.mx ?? null;
  } catch {
    return null;
  }
}

// ── CKAN ────────────────────────────────────────────────────────────

/** CKAN's read-only SQL endpoint (datastore_search_sql). */
async function ckanSql<T = Record<string, string>>(
  domain: string,
  sql: string,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{
    success?: boolean;
    result?: { records?: T[] };
    error?: unknown;
  }>(`https://${domain}/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`, opts);
  if (!body.success || !body.result?.records) {
    throw new Error(`CKAN rejected the query: ${JSON.stringify(body.error ?? {}).slice(0, 200)}`);
  }
  return body.result.records;
}

async function ckanRows<T = Record<string, unknown>>(
  domain: string,
  resourceId: string,
  limit: number,
  opts: GovFetchOpts = {},
): Promise<T[]> {
  const body = await govFetchJson<{ result?: { records?: T[] } }>(
    `https://${domain}/api/3/action/datastore_search?resource_id=${resourceId}&limit=${limit}`,
    opts,
  );
  return body.result?.records ?? [];
}

// ── ArcGIS (FeatureServer / MapServer) ──────────────────────────────

interface ArcgisFeature {
  attributes: Record<string, unknown>;
  geometry?: { x?: number; y?: number };
}

interface ArcgisQueryOpts extends GovFetchOpts {
  where?: string;
  outFields?: string;
  orderBy?: string;
  limit?: number;
  /** Request geometry in WGS84. Many layers store State Plane, so read lat/lng from here
   *  rather than from XCOORD/YCOORD attribute columns. */
  geometry?: boolean;
  distinct?: boolean;
}

async function arcgisQuery(layerUrl: string, o: ArcgisQueryOpts = {}): Promise<ArcgisFeature[]> {
  const p = new URLSearchParams({
    where: o.where ?? '1=1',
    outFields: o.outFields ?? '*',
    returnGeometry: o.geometry ? 'true' : 'false',
    f: 'json',
  });
  if (o.geometry) p.set('outSR', '4326');
  if (o.orderBy) p.set('orderByFields', o.orderBy);
  if (o.limit) p.set('resultRecordCount', String(o.limit));
  if (o.distinct) p.set('returnDistinctValues', 'true');
  const body = await govFetchJson<{ features?: ArcgisFeature[]; error?: { message?: string } }>(
    `${layerUrl}/query?${p.toString()}`,
    o,
  );
  if (body.error) throw new Error(`ArcGIS: ${body.error.message ?? 'query rejected'}`);
  return body.features ?? [];
}

/** Turn "Y"/"Yes"/"true" flag columns into a list of human-readable service labels. */
function arcgisFlagLabels(
  attrs: Record<string, unknown>,
  labelByField: Record<string, string>,
): string[] {
  return Object.entries(labelByField)
    .filter(([field]) => /^(y|yes|true)$/i.test(String(attrs[field] ?? '')))
    .map(([, label]) => label);
}

// ── Small shaping utilities ─────────────────────────────────────────

/** A recoverable "no answer" result. The hint should name something that does work. */
function govNotFound(
  reason: string,
  hint: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { found: false, reason, hint, ...extra };
}

function govNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  // Parse as-is first. Socrata returns an all-zero aggregate as "0E-24", and stripping
  // non-numeric characters turns that into "0-24" → NaN, i.e. a real zero reported as
  // unknown. Number() understands scientific notation, so only fall back to stripping
  // for values carrying formatting (currency symbols, thousands separators).
  const direct = Number(s);
  if (Number.isFinite(direct)) return direct;
  // Require a digit before stripping: otherwise "abc" reduces to "" and Number("") is 0,
  // reporting a parse failure as a real zero.
  if (!/\d/.test(s)) return null;
  const stripped = Number(s.replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(stripped) ? stripped : null;
}

/** Trimmed string argument, or undefined when absent or blank. */
function govString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

function govLimit(raw: unknown, def: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

/** Case-insensitive substring test that tolerates a missing haystack. */
function govContains(hay: unknown, needle: string): boolean {
  return typeof hay === 'string' && hay.toLowerCase().includes(needle.toLowerCase());
}

/** Join day/hours pairs into one line, dropping closed and empty days. */
function govJoinHours(parts: Array<[string, unknown]>): string | null {
  const out = parts
    .filter(([, v]) => v && String(v).trim() && !/^closed$/i.test(String(v).trim()))
    .map(([day, v]) => `${day} ${String(v).trim()}`);
  return out.length ? out.join('; ') : null;
}
/**
 * New York State DMV MCP — registered vehicles and EV adoption by county/ZIP/make,
 * DMV office locations, road-test sites, licensed driving schools, and the state's
 * licensed-facility register (inspection stations, repair shops, dealers). Keyless.
 *
 * One pack per state agency: New York publishes a 12.6M-row record-level registration
 * file, which is a different grain from California's ZIP × fuel snapshot and from
 * Washington's monthly transaction counts, so New York gets its own tools with its own
 * real arguments instead of a union schema where most arguments are ignored.
 *
 * Sources (verified live 2026-07-29):
 *   data.ny.gov Socrata — w4pv-hbkt Vehicle, Snowmobile and Boat Registrations (12.6M rows,
 *                         one row per registration record, refreshed 2026-07-02)
 *                       — 9upz-c7xg DMV office locations with weekday hours
 *                       — n6g4-x6f5 DMV road test sites
 *                       — 3p6i-cv8y DMV-licensed driving schools
 *                       — nhjr-rpi2 facilities licensed by DMV (54.6k inspection stations,
 *                         repair shops, dealers, dismantlers)
 *
 * Every tool resolves to a shaped object and never throws; a query that cannot be answered
 * comes back as { found: false, reason, hint }.
 */


const UA = 'pipeworx-mcp-ny-dmv/1.0 (+https://pipeworx.io)';
const DOMAIN = 'data.ny.gov';

const REG_RESOURCE = 'w4pv-hbkt';
const OFFICE_RESOURCE = '9upz-c7xg';
const ROAD_TEST_RESOURCE = 'n6g4-x6f5';
const SCHOOL_RESOURCE = '3p6i-cv8y';
const FACILITY_RESOURCE = 'nhjr-rpi2';

/**
 * The registration file mixes road vehicles with trailers, boats and snowmobiles. VEH is
 * 11.4M of the 12.6M rows and is what "how many cars are registered" means, so it is the
 * default; the other three codes stay reachable through `record_type`.
 */
const DEFAULT_RECORD_TYPE = 'VEH';
const RECORD_TYPES = ['VEH', 'TRL', 'BOAT', 'SNOW'];

/** Exact `fuel_type` codes New York publishes for VEH rows, by descending count. */
const NY_FUEL_CODES = ['GAS', 'DIESEL', 'ELECTRIC', 'NONE', 'FLEX', 'COMP N/G', 'OTHER', 'PROPANE'];

/** Plain words agents actually pass → the exact code New York stores. */
const FUEL_ALIASES: Record<string, string> = {
  gas: 'GAS', gasoline: 'GAS', petrol: 'GAS',
  diesel: 'DIESEL',
  electric: 'ELECTRIC', ev: 'ELECTRIC', bev: 'ELECTRIC', 'battery electric': 'ELECTRIC',
  flex: 'FLEX', 'flex-fuel': 'FLEX', 'flex fuel': 'FLEX',
  propane: 'PROPANE', lpg: 'PROPANE',
  'natural gas': 'COMP N/G', cng: 'COMP N/G', 'compressed natural gas': 'COMP N/G',
  none: 'NONE', other: 'OTHER',
};

/**
 * The `make` column is truncated to five characters — TOYOTA is stored as TOYOT and
 * CHEVROLET as CHEVR — so a caller's `make="TOYOTA"` matches nothing unless it is cut to
 * the same width first. A handful of makes collapse to a slash form instead of a prefix;
 * those are the ones a five-character cut gets wrong, so they are mapped by hand.
 */
const MAKE_ALIASES: Record<string, string> = {
  mercedes: 'ME/BE', 'mercedes-benz': 'ME/BE', 'mercedes benz': 'ME/BE', benz: 'ME/BE',
  harley: 'HA/DA', 'harley-davidson': 'HA/DA', 'harley davidson': 'HA/DA',
  'land rover': 'LA/RO', landrover: 'LA/RO', 'range rover': 'LA/RO', 'rangerover': 'LA/RO',
};

/** Turn a plain make into the five-character token New York actually stores. */
function normalizeMake(raw: string): string {
  const aliased = MAKE_ALIASES[raw.trim().toLowerCase()];
  if (aliased) return aliased;
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
}

const GROUP_COLUMNS: Record<string, string> = {
  county: 'county',
  zip: 'zip',
  city: 'city',
  fuel: 'fuel_type',
  make: 'make',
  model_year: 'model_year',
  body_type: 'body_type',
  registration_class: 'registration_class',
  record_type: 'record_type',
  state: 'state',
};

/** Business-license codes in the licensed-facility register, per the state's data dictionary. */
const BUSINESS_TYPES: Record<string, string> = {
  ABK: 'Automobile Broker',
  ATV: 'ATV only dealership',
  DIA: 'Drive-in Appraiser',
  DIS: 'Dismantler',
  DLB: 'Boat Dealer',
  DLN: 'New Car Dealer',
  DLS: 'Snowmobile Dealer',
  DLU: 'Used Car Dealer',
  DLW: 'Wholesale Dealer',
  ISD: 'Dealer Inspection Station',
  ISF: 'Fleet Inspection Station',
  ISP: 'Public Inspection Station',
  IVC: 'Itinerant Vehicle',
  MCC: 'Mobile Car Crusher',
  RS: 'Repair Shop',
  RSB: 'Repair Shop Body',
  SCC: 'Scrap Collector',
  SCP: 'Scrap Processor',
  SLP: 'Salvage Pool',
  TRS: 'Transporter',
  YTB: 'Yacht Broker',
};

/** Plain words → the licence code, so callers need not memorise the three-letter set. */
const BUSINESS_ALIASES: Record<string, string> = {
  'inspection station': 'ISP', inspection: 'ISP', 'public inspection station': 'ISP',
  'dealer inspection station': 'ISD', 'fleet inspection station': 'ISF',
  'repair shop': 'RS', repair: 'RS', mechanic: 'RS',
  'body shop': 'RSB', 'auto body': 'RSB', 'repair shop body': 'RSB',
  'used car dealer': 'DLU', 'used car': 'DLU', 'used dealer': 'DLU',
  'new car dealer': 'DLN', 'new car': 'DLN', dealership: 'DLN', dealer: 'DLN',
  'wholesale dealer': 'DLW', 'boat dealer': 'DLB', 'snowmobile dealer': 'DLS',
  dismantler: 'DIS', 'junk yard': 'DIS', salvage: 'SLP', 'salvage pool': 'SLP',
  'scrap collector': 'SCC', 'scrap processor': 'SCP',
  transporter: 'TRS', 'yacht broker': 'YTB', broker: 'ABK', 'automobile broker': 'ABK',
  appraiser: 'DIA', 'drive-in appraiser': 'DIA', atv: 'ATV', 'car crusher': 'MCC',
};

const FACILITY_GROUPS: Record<string, string> = {
  county: 'facility_county', city: 'facility_city', zip: 'facility_zip_code',
  business_type: 'business_type',
};

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const;
const DAY_ABBR: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri',
};

/**
 * The facility register stores a county as the first four letters of the county name with
 * spaces removed ("Suffolk" → SUFF, "New York" → NEWY), while the registration file stores
 * the full uppercase name. Accept either spelling in either tool.
 */
function countyCode4(v: string): string {
  return v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
}

function mapFuel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return FUEL_ALIASES[raw.toLowerCase()] ?? raw.toUpperCase();
}

/** WHERE fragments shared by the registration and EV tools. */
function buildRegFilters(args: Record<string, unknown>): {
  clauses: string[];
  applied: Record<string, unknown>;
  scope: string;
} {
  const recordType = (govString(args, 'record_type') ?? DEFAULT_RECORD_TYPE).toUpperCase();
  const clauses: string[] = [`record_type='${soqlEscape(recordType)}'`];

  const county = govString(args, 'county');
  if (county) clauses.push(`upper(county)='${soqlEscape(county.toUpperCase())}'`);
  const city = govString(args, 'city');
  if (city) clauses.push(`upper(city)='${soqlEscape(city.toUpperCase())}'`);
  const zip = govString(args, 'zip');
  if (zip) clauses.push(`zip='${soqlEscape(zip)}'`);
  const make = govString(args, 'make');
  const makeToken = make ? normalizeMake(make) : undefined;
  if (makeToken) clauses.push(`upper(make) like '${soqlEscape(makeToken)}%'`);
  const modelYear = govString(args, 'model_year');
  if (modelYear) clauses.push(`model_year='${soqlEscape(modelYear)}'`);
  const bodyType = govString(args, 'body_type');
  if (bodyType) clauses.push(`upper(body_type)='${soqlEscape(bodyType.toUpperCase())}'`);
  const regClass = govString(args, 'registration_class');
  if (regClass) clauses.push(`upper(registration_class)='${soqlEscape(regClass.toUpperCase())}'`);
  for (const flag of ['scofflaw_indicator', 'suspension_indicator', 'revocation_indicator']) {
    const v = govString(args, flag);
    if (v) clauses.push(`${flag}='${soqlEscape(/^(y|yes|true|1)$/i.test(v) ? 'Y' : 'N')}'`);
  }

  // The scope label goes into `grain`, so every filter that narrows the denominator has to
  // appear in it — a make-filtered EV share reading "for all of New York State" is a lie.
  const scopeBits = [
    modelYear,
    make ? make.toUpperCase() : null,
    bodyType,
    regClass,
    county ? `${county.toUpperCase()} County` : null,
    city,
    zip ? `ZIP ${zip}` : null,
  ].filter(Boolean);
  return {
    clauses,
    applied: {
      record_type: recordType, county, city, zip,
      make, make_matched_as: makeToken,
      model_year: modelYear, body_type: bodyType, registration_class: regClass,
    },
    scope: scopeBits.length ? scopeBits.join(', ') : 'all of New York State',
  };
}

/** Scalar `count(1)` over the registration file for a WHERE list. Null on upstream failure. */
async function countRegistrations(clauses: string[]): Promise<number | null> {
  try {
    const rows = await soqlRows<{ n?: string }>(
      DOMAIN,
      REG_RESOURCE,
      { select: 'count(1) as n', where: clauses.join(' AND ') },
      { userAgent: UA },
    );
    return govNumber(rows[0]?.n);
  } catch {
    return null;
  }
}

const tools: McpToolExport['tools'] = [
  {
    name: 'ny_dmv_vehicle_registrations',
    description:
      'Count vehicles registered in New York State from the NYS DMV record-level registration file, broken down by county, ZIP code, city, make, model year, body type, registration class or fuel type. Each of the 12.6 million source rows is one registration record, so this answers "how many cars are registered in Kings County", "how many Teslas are registered in New York", "how many pickup trucks are registered in ZIP 11201", "which New York county has the most registered vehicles", and how many registrations carry a scofflaw, suspension or revocation flag. County names are unabbreviated and upper case, with Brooklyn filed as KINGS. For electric-vehicle share use ny_dmv_ev_adoption; for a DMV office address use ny_dmv_offices.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'New York county name, unabbreviated and matched case-insensitively. Brooklyn is "KINGS", Manhattan is "NEW YORK", Staten Island is "RICHMOND", Queens is "QUEENS", the Bronx is "BRONX".' },
        city: { type: 'string', description: 'City or town of the registrant, e.g. "BROOKLYN", "BUFFALO", "ALBANY".' },
        zip: { type: 'string', description: 'Five-digit New York ZIP code, e.g. "11201".' },
        make: { type: 'string', description: 'Vehicle make; pass the everyday name, e.g. "TOYOTA", "TESLA", "FORD", "MERCEDES". New York stores makes cut to five characters (TOYOTA is filed as TOYOT), and the full name is cut to match automatically.' },
        model_year: { type: 'string', description: 'Four-digit model year, e.g. "2024".' },
        body_type: { type: 'string', description: `Body-type code, e.g. "SUBN" (SUV/station wagon), "4DSD" (4-door sedan), "PICK" (pickup), "MCY" (motorcycle), "VAN".` },
        registration_class: { type: 'string', description: 'Registration class code, e.g. "PAS" (passenger), "COM" (commercial), "MOT" (motorcycle), "SRF" (semi-trailer).' },
        record_type: { type: 'string', description: `Which register to read: ${RECORD_TYPES.join(', ')}. Defaults to VEH (road vehicles); TRL is trailers, BOAT is vessels, SNOW is snowmobiles.` },
        scofflaw_indicator: { type: 'string', description: 'Set "Y" to count only registrations flagged as scofflaw (unpaid tickets), "N" for the rest.' },
        suspension_indicator: { type: 'string', description: 'Set "Y" to count only registrations under suspension, "N" for the rest.' },
        revocation_indicator: { type: 'string', description: 'Set "Y" to count only revoked registrations, "N" for the rest.' },
        fuel_type: { type: 'string', description: `Fuel; plain words are mapped to New York's codes, e.g. "gas" → GAS, "diesel" → DIESEL, "electric" → ELECTRIC, "cng" → COMP N/G. The published codes are ${NY_FUEL_CODES.join(', ')}.` },
        group_by: { type: 'string', description: `Breakdown dimension: ${Object.keys(GROUP_COLUMNS).join(', ')}. Defaults to county.` },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200).' },
      },
    },
  },
  {
    name: 'ny_dmv_ev_adoption',
    description:
      'Measure electric-vehicle adoption in New York State: how many registered vehicles carry the ELECTRIC fuel code in each county, ZIP code, city, make or model year, and what share of all registered vehicles in that scope they represent. Reads the NYS DMV record-level registration file, so it answers "how many EVs are registered in New York", "EV share in Westchester County", "which New York county has the most electric vehicles", "how many electric Teslas are registered in Brooklyn", and how EV registrations break down by model year. New York files every plug-in vehicle under one ELECTRIC code, so battery-electric and plug-in hybrid vehicles arrive combined; Washington separates them, in wa_dmv_ev_population.',
    inputSchema: {
      type: 'object',
      properties: {
        county: { type: 'string', description: 'New York county name, unabbreviated and upper case in the source. Brooklyn is "KINGS", Manhattan is "NEW YORK", Staten Island is "RICHMOND".' },
        city: { type: 'string', description: 'City or town of the registrant, e.g. "BROOKLYN", "ROCHESTER".' },
        zip: { type: 'string', description: 'Five-digit New York ZIP code, e.g. "10583".' },
        make: { type: 'string', description: 'Vehicle make; pass the everyday name, e.g. "TESLA", "RIVIAN", "CHEVROLET". New York stores makes cut to five characters (CHEVROLET is filed as CHEVR), and the full name is cut to match automatically.' },
        model_year: { type: 'string', description: 'Four-digit model year, e.g. "2025".' },
        group_by: { type: 'string', description: `Breakdown dimension: ${Object.keys(GROUP_COLUMNS).join(', ')}. Defaults to county.` },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200). Raise it to 62 to cover every New York county.' },
      },
    },
  },
  {
    name: 'ny_dmv_offices',
    description:
      'Find New York State DMV offices with street address, public phone number, weekday opening hours and coordinates. Covers all 175 county offices, district offices, mobile offices and traffic violations bureaus in the NYS DMV directory, so it answers "DMV office in Buffalo", "where is the DMV in ZIP 12207", "NYS DMV phone number in Albany", or "which New York DMV offices are mobile". For the sites where the road test itself is given use ny_dmv_road_test_sites.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name, matched as a substring, e.g. "Buffalo", "Albany", "Brooklyn".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "12207".' },
        name: { type: 'string', description: 'Office-name substring, e.g. "Harlem", "Utica".' },
        office_type: { type: 'string', description: 'One of "COUNTY OFFICE", "DISTRICT OFFICE", "MOBILE OFFICE", "TRAFFIC VIOLATIONS BUREAU", matched as a substring.' },
        limit: { type: ['number', 'string'], description: 'Max offices to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'ny_dmv_road_test_sites',
    description:
      'List New York State DMV road test sites — where the driving test is actually administered — with the city, county, ZIP, coordinates, written directions to the starting point, and which tests each site gives (Auto, Motorcycle, CDL A/B/C, Farm, RV). Covers 444 active sites statewide, answering "where can I take my road test near Albany", "which New York road test sites offer the motorcycle test", or "CDL road test sites in Erie County". For the DMV counter that issues the licence use ny_dmv_offices.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City or town, matched as a substring, e.g. "Albany", "Yonkers".' },
        county: { type: 'string', description: 'County name in mixed case as published here, e.g. "Erie", "Suffolk", "Kings".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "12204".' },
        test_offered: { type: 'string', description: 'Test type the site must give: "Auto", "Motorcycle", "CDL A", "CDL B", "CDL C", "CDL-Other", "Farm", "RV".' },
        region: { type: 'string', description: 'DMV region, e.g. "Upstate", "Downstate", "Long Island", "New York City".' },
        limit: { type: ['number', 'string'], description: 'Max sites to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'ny_dmv_driving_schools',
    description:
      'Find driving schools licensed by the New York State DMV, with school name, street address, city, ZIP, phone number, DMV school number, coordinates, and which courses each school is licensed to teach (5-hour pre-licensing, auto, motorcycle, bus, truck, tractor-trailer). Covers 573 licensed schools statewide, answering "licensed driving schools in Brooklyn", "which New York driving schools teach the 5-hour pre-licensing course", "motorcycle driving school near Syracuse", or "CDL tractor-trailer schools in New York".',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City or town, matched as a substring, e.g. "Brooklyn", "Syracuse".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "11201".' },
        name: { type: 'string', description: 'School-name substring, e.g. "Safety", "Ace".' },
        course: { type: 'string', description: 'Course the school must be licensed for: "pre_licensing" (the 5-hour course), "auto", "motorcycle", "bus", "truck", "tractor_trailer".' },
        limit: { type: ['number', 'string'], description: 'Max schools to return (default 50, max 200).' },
      },
    },
  },
  {
    name: 'ny_dmv_licensed_facilities',
    description:
      'Search the register of 54,563 businesses licensed by the New York State DMV — vehicle inspection stations, repair shops, auto body shops, new and used car dealers, dismantlers, scrap processors, salvage pools, transporters and brokers — by city, county, ZIP, name or licence type, with the owner name, licence number, original issuance date and expiration date. Answers "is this repair shop licensed in New York", "vehicle inspection stations in ZIP 10034", "how many used car dealers are licensed in Suffolk County", or "licensed dismantlers in Erie County". Set group_by to get counts per county, city, ZIP or licence type instead of a list.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City as recorded, upper case in the source, e.g. "BROOKLYN", "NEW YORK".' },
        county: { type: 'string', description: 'County name; the source stores the first four letters with spaces removed, so both "Suffolk" and "SUFF" work, and "New York" becomes "NEWY".' },
        zip: { type: 'string', description: 'Five-digit ZIP code, e.g. "10034".' },
        name: { type: 'string', description: 'Facility-name substring; the source truncates the name to 20 characters, so use a short fragment.' },
        business_type: { type: 'string', description: `Licence type, as a code or a plain phrase: ISP public inspection station, ISD dealer inspection station, ISF fleet inspection station, RS repair shop, RSB auto body shop, DLU used car dealer, DLN new car dealer, DLW wholesale dealer, DIS dismantler, SCC scrap collector, SCP scrap processor, SLP salvage pool, TRS transporter, ABK automobile broker, DIA drive-in appraiser, ATV ATV dealership, DLB boat dealer, DLS snowmobile dealer, YTB yacht broker, IVC itinerant vehicle, MCC mobile car crusher.` },
        group_by: { type: 'string', description: `Return counts instead of a list, grouped by ${Object.keys(FACILITY_GROUPS).join(', ')}.` },
        limit: { type: ['number', 'string'], description: 'Max rows to return (default 25, max 200).' },
      },
    },
  },
];

// ── Handlers ────────────────────────────────────────────────────────

async function vehicleRegistrations(args: Record<string, unknown>): Promise<unknown> {
  const groupKey = (govString(args, 'group_by') ?? 'county').toLowerCase();
  const col = GROUP_COLUMNS[groupKey];
  if (!col) {
    return govNotFound(
      'unsupported_group_by',
      `New York supports group_by of ${Object.keys(GROUP_COLUMNS).join(', ')}. Retry with group_by="county".`,
      { supported_group_by: Object.keys(GROUP_COLUMNS) },
    );
  }
  const recordType = (govString(args, 'record_type') ?? DEFAULT_RECORD_TYPE).toUpperCase();
  if (!RECORD_TYPES.includes(recordType)) {
    return govNotFound(
      'unsupported_record_type',
      `New York files registrations under ${RECORD_TYPES.join(', ')}. Retry with record_type="VEH" for road vehicles.`,
      { requested_record_type: recordType, supported_record_types: RECORD_TYPES },
    );
  }

  const { clauses, applied, scope } = buildRegFilters(args);
  const fuel = mapFuel(govString(args, 'fuel_type'));
  if (fuel) clauses.push(`upper(fuel_type)='${soqlEscape(fuel.toUpperCase())}'`);

  const limit = govLimit(args.limit, 25, 200);
  const rows = await soqlRows<{ grouped?: string; n?: string }>(
    DOMAIN,
    REG_RESOURCE,
    {
      select: `${col} as grouped, count(1) as n`,
      where: clauses.join(' AND '),
      group: col,
      order: 'count(1) DESC',
      limit,
    },
    { userAgent: UA },
  );
  if (!rows.length) {
    return govNotFound(
      'no_matching_records',
      'No New York registrations matched those filters. County names are unabbreviated and upper case — Brooklyn is "KINGS" and Manhattan is "NEW YORK" — and `make` is matched as a substring, so try dropping `model_year` or `body_type` first.',
      { filters_applied: { ...applied, fuel_type: fuel } },
    );
  }

  const returned = rows.reduce((a, r) => a + (govNumber(r.n) ?? 0), 0);
  const truncated = rows.length >= limit;
  // Grouping by fuel or record_type returns every category the filters allow, so its sum is
  // a genuine total for the scope. Any other grouping can be cut off by `limit` and must not
  // be presented as one — a truncated county list once made New York look like a 3.2M-vehicle state.
  const isCompleteGrouping = (groupKey === 'fuel' || groupKey === 'record_type') && !truncated;
  const total = isCompleteGrouping ? returned : await countRegistrations(clauses);

  return {
    state: 'NY',
    grain: `count of active ${recordType} registration records by ${groupKey} for ${scope} (record-level source)`,
    as_of: await soqlUpdatedAt(DOMAIN, REG_RESOURCE, { userAgent: UA }),
    source: 'data.ny.gov — NYS DMV Vehicle, Snowmobile and Boat Registrations (w4pv-hbkt)',
    ...(total !== null ? { total_vehicles: total } : {}),
    sum_of_returned_rows: returned,
    truncated,
    rows: rows.map((r) => ({ [groupKey]: r.grouped ?? null, vehicles: govNumber(r.n) })),
    note:
      `record_type=${recordType} (VEH road vehicles, TRL trailers, BOAT vessels, SNOW snowmobiles). ` +
      `total_vehicles counts every matching record in the scope; sum_of_returned_rows only covers the ${rows.length} rows returned here.`,
    ...(groupKey === 'county'
      ? { county_note: 'County names are unabbreviated and upper case; Brooklyn is filed as KINGS, Manhattan as NEW YORK, Staten Island as RICHMOND.' }
      : {}),
    ...(groupKey === 'make'
      ? { make_note: 'Makes are stored cut to five characters: TOYOT is Toyota, CHEVR is Chevrolet, VOLKS is Volkswagen, ME/BE is Mercedes-Benz, HA/DA is Harley-Davidson, LA/RO is Land Rover.' }
      : {}),
  };
}

async function evAdoption(args: Record<string, unknown>): Promise<unknown> {
  const groupKey = (govString(args, 'group_by') ?? 'county').toLowerCase();
  const col = GROUP_COLUMNS[groupKey];
  if (!col) {
    return govNotFound(
      'unsupported_group_by',
      `New York EV data supports group_by of ${Object.keys(GROUP_COLUMNS).join(', ')}. Retry with group_by="county".`,
      { supported_group_by: Object.keys(GROUP_COLUMNS) },
    );
  }

  const { clauses, applied, scope } = buildRegFilters({ ...args, record_type: DEFAULT_RECORD_TYPE });
  const evClauses = [...clauses, `upper(fuel_type)='ELECTRIC'`];
  const limit = govLimit(args.limit, 25, 200);

  const [evRows, allRows, evTotal, allTotal] = await Promise.all([
    soqlRows<{ grouped?: string; n?: string }>(
      DOMAIN,
      REG_RESOURCE,
      { select: `${col} as grouped, count(1) as n`, where: evClauses.join(' AND '), group: col, order: 'count(1) DESC', limit },
      { userAgent: UA },
    ),
    // Denominator for a per-row share. Pulled generously so the EV rows can be matched back;
    // a key that falls outside it simply reports a null share rather than a wrong one.
    soqlRows<{ grouped?: string; n?: string }>(
      DOMAIN,
      REG_RESOURCE,
      { select: `${col} as grouped, count(1) as n`, where: clauses.join(' AND '), group: col, order: 'count(1) DESC', limit: 2000 },
      { userAgent: UA },
    ).catch(() => [] as Array<{ grouped?: string; n?: string }>),
    countRegistrations(evClauses),
    countRegistrations(clauses),
  ]);

  if (!evRows.length) {
    return govNotFound(
      'no_matching_records',
      'No New York electric-vehicle registrations matched those filters. County names are unabbreviated and upper case — Brooklyn is "KINGS" — and dropping `model_year` or `make` usually recovers rows.',
      { filters_applied: applied },
    );
  }

  const denom = new Map<string, number>();
  for (const r of allRows) denom.set(String(r.grouped ?? ''), govNumber(r.n) ?? 0);
  const pct = (n: number | null, d: number | null | undefined) =>
    n !== null && d ? Math.round((n / d) * 1000) / 10 : null;

  const returned = evRows.reduce((a, r) => a + (govNumber(r.n) ?? 0), 0);
  const truncated = evRows.length >= limit;

  return {
    state: 'NY',
    grain: `count of registered vehicles with the ELECTRIC fuel code by ${groupKey} for ${scope} (record-level source)`,
    as_of: await soqlUpdatedAt(DOMAIN, REG_RESOURCE, { userAgent: UA }),
    source: 'data.ny.gov — NYS DMV Vehicle, Snowmobile and Boat Registrations (w4pv-hbkt)',
    electric_vehicles: evTotal,
    total_vehicles: allTotal,
    ev_share_pct: pct(evTotal, allTotal),
    sum_of_returned_rows: returned,
    truncated,
    rows: evRows.map((r) => {
      const key = String(r.grouped ?? '');
      const ev = govNumber(r.n);
      const all = denom.get(key) ?? null;
      return {
        [groupKey]: r.grouped ?? null,
        electric_vehicles: ev,
        total_vehicles: all,
        ev_share_pct: pct(ev, all),
      };
    }),
    note:
      'New York records a single ELECTRIC fuel code, so battery-electric and plug-in hybrid vehicles are counted together here; Washington splits them and wa_dmv_ev_population returns each separately. ' +
      'electric_vehicles and total_vehicles are full counts for the scope; sum_of_returned_rows covers only the rows returned.',
    ...(groupKey === 'county'
      ? { county_note: 'County names are unabbreviated and upper case; Brooklyn is filed as KINGS. Raise `limit` to 62 to cover every county.' }
      : {}),
    ...(groupKey === 'make'
      ? { make_note: 'Makes are stored cut to five characters: TESLA is Tesla, CHEVR is Chevrolet, HYUND is Hyundai, RIVIA is Rivian, ME/BE is Mercedes-Benz.' }
      : {}),
  };
}

async function offices(args: Record<string, unknown>): Promise<unknown> {
  const raw = await soqlRows<Record<string, any>>(DOMAIN, OFFICE_RESOURCE, { limit: 1000 }, { userAgent: UA });
  let list = raw.map((r) => ({
    state: 'NY',
    name: r.office_name ?? null,
    office_type: r.office_type ?? null,
    address: [r.street_address_line_1, r.street_address_line_2].filter(Boolean).join(', ') || null,
    city: r.city ?? null,
    zip: r.zip_code ?? null,
    phone: r.public_phone_number ?? null,
    hours: govJoinHours(
      WEEKDAYS.map((d) => {
        const b = r[`${d}_beginning_hours`];
        const e = r[`${d}_ending_hours`];
        return [DAY_ABBR[d], b && e ? `${b}-${e}` : null] as [string, unknown];
      }),
    ),
    // georeference is a GeoJSON point whose coordinates are [lng, lat].
    latitude: govNumber(r.georeference?.coordinates?.[1]),
    longitude: govNumber(r.georeference?.coordinates?.[0]),
  }));

  const city = govString(args, 'city');
  if (city) list = list.filter((o) => govContains(o.city, city));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((o) => String(o.zip ?? '').startsWith(zip));
  const name = govString(args, 'name');
  if (name) list = list.filter((o) => govContains(o.name, name));
  const officeType = govString(args, 'office_type');
  if (officeType) list = list.filter((o) => govContains(o.office_type, officeType));

  if (!list.length) {
    return govNotFound(
      'no_matching_offices',
      'No NYS DMV office matched those filters. Drop the narrowest one, or call with no arguments for the full statewide directory.',
      { filters_applied: { city, zip, name, office_type: officeType } },
    );
  }
  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'NY',
    grain: 'NYS DMV office locations with weekday hours',
    as_of: await soqlUpdatedAt(DOMAIN, OFFICE_RESOURCE, { userAgent: UA }),
    source: 'data.ny.gov — NYS DMV Office Locations (9upz-c7xg)',
    office_count: list.length,
    truncated: list.length > limit,
    offices: list.slice(0, limit),
  };
}

async function roadTestSites(args: Record<string, unknown>): Promise<unknown> {
  const raw = await soqlRows<Record<string, any>>(DOMAIN, ROAD_TEST_RESOURCE, { limit: 2000 }, { userAgent: UA });
  // One source row per (site, test type); collapse to one row per site with a tests array.
  const bySite = new Map<string, Record<string, any>>();
  for (const r of raw) {
    if (String(r.is_active ?? 'Y').toUpperCase() !== 'Y') continue;
    const key = `${r.test_site_name}|${r.zip}`;
    const existing = bySite.get(key);
    if (existing) {
      if (r.test_offered && !existing.tests_offered.includes(r.test_offered)) {
        existing.tests_offered.push(r.test_offered);
      }
      continue;
    }
    bySite.set(key, {
      state: 'NY',
      site_name: r.test_site_name ?? null,
      city: r.city ?? null,
      county: r.county_name ?? null,
      zip: r.zip ?? null,
      region: r.region_name ?? null,
      district: r.district_name ?? null,
      tests_offered: r.test_offered ? [r.test_offered] : [],
      directions: r.directions ?? null,
      latitude: govNumber(r.latitude),
      longitude: govNumber(r.longitude),
    });
  }
  let list = [...bySite.values()];

  const city = govString(args, 'city');
  if (city) list = list.filter((s) => govContains(s.city, city));
  const county = govString(args, 'county');
  if (county) list = list.filter((s) => govContains(s.county, county));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((s) => String(s.zip ?? '').startsWith(zip));
  const region = govString(args, 'region');
  if (region) list = list.filter((s) => govContains(s.region, region));
  const test = govString(args, 'test_offered');
  if (test) list = list.filter((s) => s.tests_offered.some((t: string) => govContains(t, test)));

  if (!list.length) {
    return govNotFound(
      'no_matching_sites',
      'No New York road test site matched those filters. `county` is mixed case here ("Erie", "Suffolk"), and test_offered is one of Auto, Motorcycle, CDL A, CDL B, CDL C, CDL-Other, Farm, RV. Call with no arguments for all 444 active sites.',
      { filters_applied: { city, county, zip, region, test_offered: test } },
    );
  }
  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'NY',
    grain: 'active NYS DMV road test sites with the test types each one administers',
    as_of: await soqlUpdatedAt(DOMAIN, ROAD_TEST_RESOURCE, { userAgent: UA }),
    source: 'data.ny.gov — NYS DMV Road Test Sites (n6g4-x6f5)',
    site_count: list.length,
    truncated: list.length > limit,
    sites: list.slice(0, limit),
  };
}

const COURSE_FIELDS: Record<string, string> = {
  pre_licensing: 'pre_licensing', auto: 'auto', motorcycle: 'motorcycle',
  bus: 'bus', truck: 'truck', tractor_trailer: 'tractor_trailer',
};

async function drivingSchools(args: Record<string, unknown>): Promise<unknown> {
  const raw = await soqlRows<Record<string, any>>(DOMAIN, SCHOOL_RESOURCE, { limit: 2000 }, { userAgent: UA });
  let list = raw.map((r) => ({
    state: 'NY',
    school_name: r.school_name ?? null,
    school_number: r.school_number ?? null,
    address: r.street ?? null,
    city: r.city ?? null,
    zip: r.zip ?? null,
    phone: r.phone_number ?? null,
    // Every course column is the string "True" or "False".
    courses: Object.keys(COURSE_FIELDS).filter((k) => String(r[COURSE_FIELDS[k]] ?? '').toLowerCase() === 'true'),
    latitude: govNumber(r.georeference?.coordinates?.[1]),
    longitude: govNumber(r.georeference?.coordinates?.[0]),
  }));

  const city = govString(args, 'city');
  if (city) list = list.filter((s) => govContains(s.city, city));
  const zip = govString(args, 'zip');
  if (zip) list = list.filter((s) => String(s.zip ?? '').startsWith(zip));
  const name = govString(args, 'name');
  if (name) list = list.filter((s) => govContains(s.school_name, name));
  const course = govString(args, 'course');
  if (course) {
    const key = course.toLowerCase().replace(/[\s-]+/g, '_');
    if (!COURSE_FIELDS[key]) {
      return govNotFound(
        'unsupported_course',
        `New York licenses driving schools for ${Object.keys(COURSE_FIELDS).join(', ')}. Retry with course="pre_licensing" for the 5-hour course.`,
        { requested_course: course, supported_courses: Object.keys(COURSE_FIELDS) },
      );
    }
    list = list.filter((s) => s.courses.includes(key));
  }

  if (!list.length) {
    return govNotFound(
      'no_matching_schools',
      'No NYS DMV-licensed driving school matched those filters. Try a broader `city` or drop `course`; calling with no arguments returns all 573 licensed schools.',
      { filters_applied: { city, zip, name, course } },
    );
  }
  const limit = govLimit(args.limit, 50, 200);
  return {
    state: 'NY',
    grain: 'driving schools licensed by the NYS DMV, with the courses each is licensed to teach',
    as_of: await soqlUpdatedAt(DOMAIN, SCHOOL_RESOURCE, { userAgent: UA }),
    source: 'data.ny.gov — NYS DMV Driving Schools (3p6i-cv8y)',
    school_count: list.length,
    truncated: list.length > limit,
    schools: list.slice(0, limit),
  };
}

async function licensedFacilities(args: Record<string, unknown>): Promise<unknown> {
  const clauses: string[] = [];
  const city = govString(args, 'city');
  if (city) clauses.push(`upper(facility_city)='${soqlEscape(city.toUpperCase())}'`);
  const county = govString(args, 'county');
  if (county) clauses.push(`facility_county='${soqlEscape(countyCode4(county))}'`);
  const zip = govString(args, 'zip');
  if (zip) clauses.push(`facility_zip_code='${soqlEscape(zip)}'`);
  const name = govString(args, 'name');
  if (name) clauses.push(`upper(facility_name) like '%${soqlEscape(name.toUpperCase())}%'`);

  const rawType = govString(args, 'business_type');
  let bizType: string | undefined;
  if (rawType) {
    bizType = BUSINESS_ALIASES[rawType.toLowerCase()] ?? rawType.toUpperCase();
    if (!BUSINESS_TYPES[bizType]) {
      return govNotFound(
        'unsupported_business_type',
        `New York licenses these facility types: ${Object.entries(BUSINESS_TYPES).map(([c, l]) => `${c} (${l})`).join(', ')}. Retry with business_type="ISP" for public inspection stations.`,
        { requested_business_type: rawType, supported_business_types: BUSINESS_TYPES },
      );
    }
    clauses.push(`business_type='${soqlEscape(bizType)}'`);
  }

  const where = clauses.length ? clauses.join(' AND ') : undefined;
  const limit = govLimit(args.limit, 25, 200);
  const asOf = await soqlUpdatedAt(DOMAIN, FACILITY_RESOURCE, { userAgent: UA });
  const source = 'data.ny.gov — Facilities Licensed by the NYS DMV (nhjr-rpi2)';
  const applied = { city, county: county ? countyCode4(county) : undefined, zip, name, business_type: bizType };

  const groupKey = govString(args, 'group_by')?.toLowerCase();
  if (groupKey) {
    const col = FACILITY_GROUPS[groupKey];
    if (!col) {
      return govNotFound(
        'unsupported_group_by',
        `Counts are available by ${Object.keys(FACILITY_GROUPS).join(', ')}. Retry with group_by="business_type".`,
        { supported_group_by: Object.keys(FACILITY_GROUPS) },
      );
    }
    const rows = await soqlRows<{ grouped?: string; n?: string }>(
      DOMAIN,
      FACILITY_RESOURCE,
      { select: `${col} as grouped, count(1) as n`, where, group: col, order: 'count(1) DESC', limit },
      { userAgent: UA },
    );
    if (!rows.length) {
      return govNotFound(
        'no_matching_facilities',
        'No NYS DMV-licensed facility matched those filters. County is the first four letters of the name ("SUFF" for Suffolk, "NEWY" for New York), and city is upper case in this file.',
        { filters_applied: applied },
      );
    }
    const returned = rows.reduce((a, r) => a + (govNumber(r.n) ?? 0), 0);
    const truncated = rows.length >= limit;
    return {
      state: 'NY',
      grain: `count of DMV-licensed facilities by ${groupKey}`,
      as_of: asOf,
      source,
      sum_of_returned_rows: returned,
      truncated,
      rows: rows.map((r) => ({
        [groupKey]: r.grouped ?? null,
        ...(groupKey === 'business_type' ? { business_type_label: BUSINESS_TYPES[String(r.grouped ?? '')] ?? null } : {}),
        facilities: govNumber(r.n),
      })),
      note: 'One row per business licence, so a facility holding two licences (a repair shop that is also an inspection station) is counted once under each.',
    };
  }

  const rows = await soqlRows<Record<string, any>>(
    DOMAIN,
    FACILITY_RESOURCE,
    { where, order: 'facility_name', limit },
    { userAgent: UA },
  );
  if (!rows.length) {
    return govNotFound(
      'no_matching_facilities',
      'No NYS DMV-licensed facility matched those filters. County is the first four letters of the name ("SUFF" for Suffolk, "NEWY" for New York), city is upper case, and `name` is truncated to 20 characters in the source so a short fragment works best.',
      { filters_applied: applied },
    );
  }
  return {
    state: 'NY',
    grain: 'businesses holding a NYS DMV facility licence, one row per licence',
    as_of: asOf,
    source,
    returned_facilities: rows.length,
    truncated: rows.length >= limit,
    facilities: rows.map((r) => ({
      state: 'NY',
      facility_number: r.facility ?? null,
      facility_name: [r.facility_name, r.facility_name_overflow].filter(Boolean).join(' ').trim() || null,
      business_type: r.business_type ?? null,
      business_type_label: BUSINESS_TYPES[String(r.business_type ?? '')] ?? null,
      owner_name: [r.owner_name, r.owner_name_overflow].filter(Boolean).join(' ').trim() || null,
      address: r.facility_street ?? null,
      city: r.facility_city ?? null,
      county_code: r.facility_county ?? null,
      zip: r.facility_zip_code ?? null,
      original_issuance_date: r.origional_issuance_date ?? null,
      last_renewal_date: typeof r.last_renewal_date === 'string' ? r.last_renewal_date.slice(0, 10) : null,
      expiration_date: r.expiration_date ?? null,
      latitude: govNumber(r.georeference?.coordinates?.[1]),
      longitude: govNumber(r.georeference?.coordinates?.[0]),
    })),
    note: 'The register keeps historical licences, so check expiration_date before treating a row as a currently valid licence. Set group_by to count facilities per county, city, ZIP or licence type.',
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    switch (name) {
      case 'ny_dmv_vehicle_registrations': return await vehicleRegistrations(args);
      case 'ny_dmv_ev_adoption': return await evAdoption(args);
      case 'ny_dmv_offices': return await offices(args);
      case 'ny_dmv_road_test_sites': return await roadTestSites(args);
      case 'ny_dmv_driving_schools': return await drivingSchools(args);
      case 'ny_dmv_licensed_facilities': return await licensedFacilities(args);
      default:
        return govNotFound('unknown_tool', `ny-dmv exposes ${tools.map((t) => t.name).join(', ')}.`, { requested_tool: name });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      error: `ny-dmv/${name}: ${message}`,
      hint: /timeout|abort/i.test(message)
        ? 'data.ny.gov timed out. The registration file is 12.6M rows, so retry once and add a `county` or `zip` filter, or lower `limit`, to reduce the work upstream.'
        : 'data.ny.gov refused the request or changed shape. Retry once; if it persists the dataset may have been republished under a new Socrata id.',
    };
  }
}

export default { tools, callTool } satisfies McpToolExport;
export { tools, callTool };
