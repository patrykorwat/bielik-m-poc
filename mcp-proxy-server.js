#!/usr/bin/env node

/**
 * MCP Proxy Server - HTTP/WebSocket bridge to MCP stdio server
 * Allows browser clients to communicate with MCP servers
 */

import express from 'express';
import cors from 'cors';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = 3001;

// Enable CORS for browser access
app.use(cors());
app.use(express.json());

// MCP server process
let mcpProcess = null;
let requestId = 0;
let pendingRequests = new Map();
let buffer = '';
let tools = [];

/**
 * Start MCP server
 */
function startMCPServer() {
  const serverPath = join(__dirname, 'mcp-sympy-server', 'dist', 'index.js');

  console.log('Starting MCP SymPy server:', serverPath);

  mcpProcess = spawn('node', [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  mcpProcess.stdout.on('data', (data) => {
    buffer += data.toString();
    processBuffer();
  });

  mcpProcess.stderr.on('data', (data) => {
    console.log('[MCP Server]', data.toString());
  });

  mcpProcess.on('exit', (code) => {
    console.log('MCP server exited with code:', code);
    mcpProcess = null;
  });

  mcpProcess.on('error', (error) => {
    console.error('MCP server error:', error);
  });

  // Initialize MCP connection
  setTimeout(() => {
    initializeMCP();
  }, 500);
}

/**
 * Process incoming messages from MCP server
 */
function processBuffer() {
  const lines = buffer.split('\n');
  buffer = lines.pop() || '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const message = JSON.parse(line);

      if ('id' in message && message.id !== undefined) {
        const pending = pendingRequests.get(message.id);
        if (pending) {
          pendingRequests.delete(message.id);

          if (message.error) {
            pending.reject(new Error(message.error.message || 'MCP error'));
          } else {
            pending.resolve(message.result);
          }
        }
      }
    } catch (error) {
      console.error('Failed to parse MCP message:', line, error);
    }
  }
}

/**
 * Send request to MCP server
 */
function sendMCPRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess || !mcpProcess.stdin) {
      reject(new Error('MCP server not running'));
      return;
    }

    const id = ++requestId;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    pendingRequests.set(id, { resolve, reject });

    try {
      mcpProcess.stdin.write(JSON.stringify(request) + '\n');
    } catch (error) {
      pendingRequests.delete(id);
      reject(error);
    }

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error('MCP request timeout'));
      }
    }, 30000);
  });
}

/**
 * Initialize MCP connection
 */
async function initializeMCP() {
  try {
    const result = await sendMCPRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'mcp-proxy-server',
        version: '1.0.0',
      },
    });

    console.log('MCP initialized:', result);

    // List tools
    const toolsResult = await sendMCPRequest('tools/list', {});
    tools = toolsResult.tools || [];
    console.log('Available tools:', tools.map(t => t.name));
  } catch (error) {
    console.error('MCP initialization failed:', error);
  }
}

// API Routes

/**
 * GET /health - Health check
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    mcpConnected: mcpProcess !== null,
    toolsCount: tools.length,
  });
});

/**
 * GET /tools - List available tools
 */
app.get('/tools', (req, res) => {
  res.json({ tools });
});

/**
 * POST /tools/call - Call a tool
 */
app.post('/tools/call', async (req, res) => {
  try {
    const { name, arguments: args } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Tool name is required' });
    }

    console.log(`Calling tool: ${name}`, args);

    const result = await sendMCPRequest('tools/call', {
      name,
      arguments: args || {},
    });

    res.json(result);
  } catch (error) {
    console.error('Tool call error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Tool call failed',
    });
  }
});

// Start server
startMCPServer();

app.listen(PORT, () => {
  console.log(`MCP Proxy Server running on http://localhost:${PORT}`);
  console.log('Available endpoints:');
  console.log('  GET  /health - Health check');
  console.log('  GET  /tools - List available tools');
  console.log('  POST /tools/call - Call a tool');
});
