# @pipeworx/ny-dmv

New York State DMV MCP — registered vehicles and EV adoption, DMV offices, road test sites, licensed driving schools, and the DMV-licensed facility register. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Tools

| Tool | What it returns |
|------|-----------------|
| `ny_dmv_vehicle_registrations(...)` | Counts of registration records by county, ZIP, city, make, model year, body type, registration class or fuel, from the 12.6M-row record-level file. Also filters on scofflaw / suspension / revocation flags. |
| `ny_dmv_ev_adoption(...)` | ELECTRIC-fuel registration counts plus an EV share of all registered vehicles, per county / ZIP / city / make / model year. |
| `ny_dmv_offices(...)` | 175 NYS DMV offices with address, public phone, weekday hours and coordinates. |
| `ny_dmv_road_test_sites(...)` | 444 active road test sites with the test types each administers and written directions to the starting point. |
| `ny_dmv_driving_schools(...)` | 573 DMV-licensed driving schools with school number, phone and the courses each is licensed to teach. |
| `ny_dmv_licensed_facilities(...)` | 54,563 DMV-licensed businesses — inspection stations, repair shops, dealers, dismantlers — searchable, or counted by county / city / ZIP / licence type. |

## Auth

Keyless. All five datasets are public Socrata resources on `data.ny.gov`; no app token is required at the volumes this pack issues.

## Per-state gotchas

- **`record_type` is the first thing to get right.** `w4pv-hbkt` mixes road vehicles (VEH, 11.4M rows) with trailers (TRL), boats (BOAT) and snowmobiles (SNOW). Every registration query defaults to `VEH`; an unfiltered sum is a fleet of things, not a fleet of cars.
- **County names are unabbreviated and upper case, and NYC boroughs use the county name.** Brooklyn is `KINGS`, Manhattan is `NEW YORK`, Staten Island is `RICHMOND`. The Bronx and Queens keep their names.
- **`make` is truncated to five characters.** Toyota is stored as `TOYOT`, Chevrolet as `CHEVR`, Volkswagen as `VOLKS`. Three makes collapse to a slash form instead: `ME/BE` (Mercedes-Benz), `HA/DA` (Harley-Davidson), `LA/RO` (Land Rover). The pack cuts and aliases the caller's make automatically, so pass the everyday name.
- **New York has one `ELECTRIC` fuel code.** Battery-electric and plug-in hybrid vehicles are not separable in this source. Washington splits them — see `wa_dmv_ev_population`.
- **The facility register spells counties differently from the registration file.** `nhjr-rpi2` stores the first four letters of the county with spaces removed: `SUFF`, `NASS`, `NEWY`. The pack accepts either spelling.
- **The facility register keeps expired licences.** Rows carry an `expiration_date`, and some are years past. Check it before treating a row as a currently valid licence.
- **A facility holds one row per licence.** A repair shop that is also a public inspection station appears once under `RS` and once under `ISP`, so licence counts exceed the number of distinct businesses.
- **`sum_of_returned_rows` is not a total.** Row lists are cut off by `limit`; `total_vehicles` (a separate full count over the same filters) is the figure to quote.

## Data sources

- Registrations — https://data.ny.gov/resource/w4pv-hbkt.json (Vehicle, Snowmobile and Boat Registrations)
- Offices — https://data.ny.gov/resource/9upz-c7xg.json (DMV Office Locations)
- Road test sites — https://data.ny.gov/resource/n6g4-x6f5.json (DMV Road Test Sites)
- Driving schools — https://data.ny.gov/resource/3p6i-cv8y.json (DMV Driving Schools)
- Licensed facilities — https://data.ny.gov/resource/nhjr-rpi2.json (Facilities Licensed by the DMV)

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ny-dmv": {
      "url": "https://gateway.pipeworx.io/ny-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ny-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1679+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ny_dmv_vehicle_registrations \
  -H 'Content-Type: application/json' \
  -d '{"group_by":"county","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ny_dmv_vehicle_registrations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ny-dmv": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ny-dmv"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ny-dmv
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ny Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
