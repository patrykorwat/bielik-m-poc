#!/usr/bin/env node

/**
 * Simple test script to verify SymPy server functionality
 * This demonstrates how to call the MCP server's tools
 */

import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const serverPath = join(__dirname, "dist", "index.js");

console.log("Testing MCP SymPy Server...\n");

// Start the server
const server = spawn("node", [serverPath]);

let responseBuffer = "";

server.stdout.on("data", (data) => {
  responseBuffer += data.toString();

  // Try to parse complete JSON-RPC messages
  const lines = responseBuffer.split("\n");
  responseBuffer = lines.pop() || ""; // Keep incomplete line

  lines.forEach(line => {
    if (line.trim()) {
      try {
        const message = JSON.parse(line);
        console.log("Received:", JSON.stringify(message, null, 2));
      } catch (e) {
        console.log("Raw output:", line);
      }
    }
  });
});

server.stderr.on("data", (data) => {
  console.error("Server log:", data.toString());
});

server.on("close", (code) => {
  console.log(`Server exited with code ${code}`);
});

// Wait for server to start
setTimeout(() => {
  // Send initialize request
  const initRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "test-client",
        version: "1.0.0"
      }
    }
  };

  console.log("\nSending initialize request...");
  server.stdin.write(JSON.stringify(initRequest) + "\n");

  // List tools after initialization
  setTimeout(() => {
    const listToolsRequest = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    };

    console.log("\nSending tools/list request...");
    server.stdin.write(JSON.stringify(listToolsRequest) + "\n");

    // Test a simple calculation
    setTimeout(() => {
      const calcRequest = {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "sympy_differentiate",
          arguments: {
            expression: "x**2 + 2*x",
            variable: "x"
          }
        }
      };

      console.log("\nSending differentiate request (d/dx of x^2 + 2x)...");
      server.stdin.write(JSON.stringify(calcRequest) + "\n");

      // Clean exit after test
      setTimeout(() => {
        console.log("\nTest complete. Shutting down...");
        server.kill();
        process.exit(0);
      }, 2000);
    }, 1000);
  }, 1000);
}, 1000);
