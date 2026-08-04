# @pipeworx/ny-dmv

New York State DMV MCP — registered vehicles and EV adoption, DMV offices, road test sites, licensed driving schools, and the DMV-licensed facility register. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Ny Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
