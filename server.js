import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import open from "open";
import http from "node:http";

const app = express();
app.use(express.static("public"));

const DALOOPA_MCP_URL = "https://mcp.daloopa.com/server/mcp";
const PORT = process.env.PORT || 3000;
const CALLBACK_PORT = 8090;

// ── Auth: build transport options from env vars ──────────────────────

function buildTransportOptions() {
  const headers = {};

  if (process.env.DALOOPA_API_KEY) {
    headers["X-API-KEY"] = process.env.DALOOPA_API_KEY;
    console.log("Auth: using API key");
  } else if (process.env.DALOOPA_BEARER_TOKEN) {
    headers["Authorization"] = `Bearer ${process.env.DALOOPA_BEARER_TOKEN}`;
    console.log("Auth: using bearer token");
  }

  if (Object.keys(headers).length > 0) {
    return { requestInit: { headers } };
  }

  console.log("Auth: using OAuth flow (browser redirect)");
  return { authProvider: createOAuthProvider() };
}

// ── OAuth provider (MCP spec) ────────────────────────────────────────

function createOAuthProvider() {
  let tokens;
  let clientInfo;
  let storedCodeVerifier;

  return {
    get redirectUrl() {
      return new URL(`http://localhost:${CALLBACK_PORT}/callback`);
    },
    get clientMetadata() {
      return {
        redirect_uris: [`http://localhost:${CALLBACK_PORT}/callback`],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "AAPL Revenue Dashboard",
        client_uri: `http://localhost:${PORT}`,
      };
    },
    clientInformation() {
      return clientInfo;
    },
    saveClientInformation(info) {
      clientInfo = info;
    },
    tokens() {
      return tokens;
    },
    saveTokens(newTokens) {
      tokens = newTokens;
    },
    saveCodeVerifier(verifier) {
      storedCodeVerifier = verifier;
    },
    codeVerifier() {
      return storedCodeVerifier;
    },
    redirectToAuthorization(authorizationUrl) {
      console.log("Opening browser for Daloopa login...");
      open(authorizationUrl.toString());
    },
  };
}

// ── MCP Client ───────────────────────────────────────────────────────

let mcpClient = null;

function waitForOAuthCallback() {
  return new Promise((resolve, reject) => {
    const callbackServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(
            "<h1>Authenticated! You can close this tab and return to the dashboard.</h1>"
          );
          callbackServer.close();
          resolve(code);
        } else {
          const error = url.searchParams.get("error") || "no code received";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authentication failed: ${error}</h1>`);
          callbackServer.close();
          reject(new Error(error));
        }
      }
    });
    callbackServer.listen(CALLBACK_PORT, () => {
      console.log(`OAuth callback listening on port ${CALLBACK_PORT}`);
    });
  });
}

async function connectToMCP() {
  const client = new Client({
    name: "aapl-revenue-dashboard",
    version: "1.0.0",
  });

  const transportOptions = buildTransportOptions();
  const transport = new StreamableHTTPClientTransport(
    new URL(DALOOPA_MCP_URL),
    transportOptions
  );

  try {
    await client.connect(transport);
    console.log("Connected to Daloopa MCP server");
  } catch (error) {
    if (error.code === 401 || error.constructor?.name === "UnauthorizedError") {
      console.log("OAuth redirect initiated — waiting for browser callback...");
      const code = await waitForOAuthCallback();
      await transport.finishAuth(code);
      await client.connect(transport);
      console.log("Connected after OAuth");
    } else {
      throw error;
    }
  }

  mcpClient = client;
}

// ── Daloopa tool helpers ─────────────────────────────────────────────

function parseToolResult(result) {
  if (result.content && result.content.length > 0) {
    const text = result.content[0].text;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result;
}

function computePast4Quarters() {
  const now = new Date();
  const y = now.getFullYear();
  const q = Math.ceil((now.getMonth() + 1) / 3);

  const quarters = [];
  let year = y;
  let quarter = q;
  for (let i = 0; i < 4; i++) {
    quarters.unshift(`${year}Q${quarter}`);
    quarter--;
    if (quarter === 0) {
      quarter = 4;
      year--;
    }
  }
  return quarters;
}

async function fetchAAPLRevenue() {
  // Step 1: Find AAPL company_id
  console.log("Calling discover_companies...");
  const discoverResult = await mcpClient.callTool({
    name: "discover_companies",
    arguments: { keyword: "AAPL" },
  });
  const companies = parseToolResult(discoverResult);
  const company = Array.isArray(companies) ? companies[0] : companies;
  const companyId = company.company_id ?? company.id;
  console.log(`Found company_id: ${companyId}`);

  // Step 2: Find revenue series_id
  console.log("Calling discover_company_series...");
  const seriesResult = await mcpClient.callTool({
    name: "discover_company_series",
    arguments: { company_id: companyId },
  });
  const allSeries = parseToolResult(seriesResult);
  const seriesList = Array.isArray(allSeries) ? allSeries : [];

  const revenueSeries = seriesList.find((s) => {
    const name = (s.series_name || s.name || "").toLowerCase();
    return (
      (name === "revenue" ||
        name === "total revenue" ||
        name === "net revenue" ||
        name === "total net revenue") &&
      !name.includes("cost")
    );
  });

  if (!revenueSeries) {
    // Fallback: pick first series containing "revenue" (but not "cost of revenue")
    const fallback = seriesList.find((s) => {
      const name = (s.series_name || s.name || "").toLowerCase();
      return name.includes("revenue") && !name.includes("cost");
    });
    if (!fallback) {
      throw new Error(
        "Could not find a revenue series. Available: " +
          seriesList
            .slice(0, 20)
            .map((s) => s.series_name || s.name)
            .join(", ")
      );
    }
    Object.assign(revenueSeries ?? {}, fallback);
  }

  const seriesId = revenueSeries.series_id ?? revenueSeries.id;
  console.log(
    `Found revenue series: "${revenueSeries.series_name || revenueSeries.name}" (id: ${seriesId})`
  );

  // Step 3: Fetch fundamentals for past 4 quarters
  const periods = computePast4Quarters();
  console.log(`Calling get_fundamentals_data for periods: ${periods.join(", ")}...`);

  const dataResult = await mcpClient.callTool({
    name: "get_fundamentals_data",
    arguments: {
      company_id: companyId,
      periods,
      series_ids: [seriesId],
    },
  });

  const datapoints = parseToolResult(dataResult);
  console.log(`Received ${Array.isArray(datapoints) ? datapoints.length : 0} datapoints`);
  return Array.isArray(datapoints) ? datapoints : [];
}

// ── Cache ────────────────────────────────────────────────────────────

let cachedData = null;
let cacheTime = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// ── REST API ─────────────────────────────────────────────────────────

app.get("/api/revenue", async (req, res) => {
  try {
    if (!mcpClient) {
      return res.status(503).json({
        error: "MCP client not connected. Check server logs for details.",
      });
    }

    if (cachedData && Date.now() - cacheTime < CACHE_TTL) {
      return res.json({ success: true, data: cachedData, cached: true });
    }

    const data = await fetchAAPLRevenue();
    cachedData = data;
    cacheTime = Date.now();
    res.json({ success: true, data });
  } catch (error) {
    console.error("Error fetching revenue:", error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/status", (_req, res) => {
  res.json({
    connected: mcpClient !== null,
    authMethod: process.env.DALOOPA_API_KEY
      ? "api-key"
      : process.env.DALOOPA_BEARER_TOKEN
        ? "bearer-token"
        : "oauth",
  });
});

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  try {
    await connectToMCP();
  } catch (err) {
    console.error("Failed to connect to Daloopa MCP:", err.message);
    console.log("Server will start anyway — /api/revenue will return 503 until connected.");
  }

  app.listen(PORT, () => {
    console.log(`Dashboard: http://localhost:${PORT}`);
  });
}

main();
