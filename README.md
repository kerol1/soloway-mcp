# SoloWay MCP Server

[![kerol1/soloway-mcp MCP server](https://glama.ai/mcp/servers/kerol1/soloway-mcp/badges/score.svg)](https://glama.ai/mcp/servers/kerol1/soloway-mcp)

Live intercity bus-trip search across **Ukraine and Europe** as a remote [MCP](https://modelcontextprotocol.io) server. Read-only, no API key, no auth. Powered by [soloway.com.ua](https://soloway.com.ua) — bookings are completed there, not through the tools.

**Remote endpoint:** `https://mcp.soloway.com.ua/mcp` (streamable HTTP, stateless)

## Tools

| Tool | What it does |
|---|---|
| `search_trips` | Trips between two cities on a date — live prices, free seats, carriers, duration, transfers, passenger discounts, and a booking deep-link. City names resolve automatically (uk/en), with disambiguation when several cities match. |
| `get_calendar_prices` | Cheapest price for each day of a month on a route — find the cheapest day to travel. |
| `get_trip_details` | Full details of one trip from search results — stops, carrier discounts, seat info. |
| `ping` | Liveness check. |

All tools declare `outputSchema`, `readOnlyHint: true` and `openWorldHint: false`.

## Connect

Works with any MCP client that speaks streamable HTTP. Step-by-step instructions for Claude, ChatGPT and others: [soloway.com.ua/connect](https://soloway.com.ua/connect).

Claude Code:

```bash
claude mcp add --transport http soloway https://mcp.soloway.com.ua/mcp
```

## Self-hosting

The server is a thin, cache-friendly proxy over the public SoloWay API — the Docker image works out of the box:

```bash
docker build -t soloway-mcp .
docker run -p 8088:8088 soloway-mcp
# then point your MCP client at http://localhost:8088/mcp
```

### Configuration

All settings are env vars with sane defaults — see [.env.example](.env.example). The ones you may care about:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `8088` | HTTP port |
| `BACKEND_BASE_URL` | `https://soloway.com.ua` (image) | SoloWay API origin |
| `EXPECTED_HOST` | `*` (image) | CSV of accepted `Host` values for no-Origin requests. `*` accepts any host and disables the SDK DNS-rebinding belt — fine for local/sandbox runs; **pin your public hostname in production** (our prod sets `mcp.soloway.com.ua`). |
| `ALLOWED_ORIGINS` | claude.ai / openai.com / soloway.com.ua | CSV, suffix wildcards supported (`https://*.claude.ai`) |
| `DEFAULT_LOCALE` | `uk` | `uk` or `en` |
| `SEARCH_MAX_RESULTS` | `40` | Cap on trips returned per search |

## Development

```bash
npm install
npm run dev        # tsx watch
npm test           # vitest
npm run typecheck
```

`server.json` is the [MCP registry](https://modelcontextprotocol.io/registry) manifest; `eval/evals.xml` holds stable-answer evaluations in mcp-builder format.

## License

[MIT](LICENSE)
