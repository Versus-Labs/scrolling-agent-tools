# scrolling.ai agent tools

Make short video ads with [scrolling.ai](https://scrolling.ai) from your AI assistant or your terminal: Create videos with your Creators, Swap a product or person into a video, and Remake an ad for your brand.

Making videos needs a scrolling.ai paid plan and spends your credits. Without a plan, connected apps can only look (brands, Creators, products, videos). You can see and disconnect every connection in **My account → Connected apps**.

## Claude, ChatGPT and other MCP apps

Add scrolling.ai as a connector with this URL:

```
https://mcp.scrolling.ai/mcp
```

- **claude.ai / Claude Desktop:** Customize → Connectors → Add custom connector.
- **ChatGPT:** turn on developer mode in settings, then add a custom MCP connector with the URL above (OAuth).
- **Claude Code:** `claude mcp add --transport http scrolling https://mcp.scrolling.ai/mcp`, then `/mcp` to sign in.

You sign in on scrolling.ai and choose what the app may do. Before any video is made, the app is shown its price; it can't buy credits, change your plan or see billing.

## Claude Code plugins

```
/plugin marketplace add Versus-Labs/scrolling-agent-tools
/plugin install scrolling@scrolling-ai        # a skill that drives the scrolling CLI
/plugin install scrolling-mcp@scrolling-ai    # the scrolling.ai connector
```

## The `scrolling` CLI

```sh
npm i -g @scrolling/cli
scrolling login            # opens scrolling.ai; --device for a code to type, --no-input for agents
scrolling account
scrolling cost create --length 15 --quality 480p
scrolling create --brand <brand id> --idea "…" --length 15 --yes --wait
```

Every command takes `--json`. Commands that spend credits show the price first and, without a terminal or `--yes`, stop with exit code 9 so an agent can ask you. Full reference: [cli/README.md](cli/README.md).

## Repository

- `cli/`: the `@scrolling/cli` package (Node.js ≥ 22.12).
- `plugins/`: the Claude Code plugins; `.claude-plugin/marketplace.json` lists them.
- Releases: bump `cli/package.json`'s version and push the tag `cli-v<version>`; GitHub Actions publishes to npm with provenance.

MIT licensed.
