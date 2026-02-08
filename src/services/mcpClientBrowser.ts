/**
 * Browser-compatible MCP Client
 * Communicates with MCP proxy server via HTTP
 */

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required: string[];
  };
}

export interface MCPToolResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
}

export class MCPClientBrowser {
  private proxyUrl: string;
  private tools: MCPTool[] = [];
  private connected = false;

  constructor(proxyUrl: string = 'http://localhost:3001') {
    this.proxyUrl = proxyUrl;
  }

  /**
   * Connect to MCP proxy server and fetch tools
   */
  async connect(): Promise<void> {
    try {
      // Check health
      const healthResponse = await fetch(`${this.proxyUrl}/health`);
      if (!healthResponse.ok) {
        throw new Error('MCP proxy server is not responding');
      }

      const health = await healthResponse.json();
      if (!health.mcpConnected) {
        throw new Error('MCP server is not connected to proxy');
      }

      // Fetch tools
      const toolsResponse = await fetch(`${this.proxyUrl}/tools`);
      if (!toolsResponse.ok) {
        throw new Error('Failed to fetch tools');
      }

      const toolsData = await toolsResponse.json();
      this.tools = toolsData.tools || [];
      this.connected = true;

      console.log('MCP client connected. Available tools:', this.tools.map(t => t.name));
    } catch (error) {
      console.error('Failed to connect to MCP:', error);
      throw error;
    }
  }

  /**
   * Get list of available tools
   */
  async listTools(): Promise<MCPTool[]> {
    if (!this.connected) {
      await this.connect();
    }
    return this.tools;
  }

  /**
   * Get cached tools
   */
  getTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * Call a tool via MCP proxy
   */
  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    if (!this.connected) {
      throw new Error('MCP client not connected');
    }

    try {
      const response = await fetch(`${this.proxyUrl}/tools/call`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name,
          arguments: args,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Tool call failed');
      }

      const result = await response.json();
      return result;
    } catch (error) {
      console.error('Tool call failed:', error);
      throw error;
    }
  }

  /**
   * Disconnect (no-op for HTTP client)
   */
  disconnect(): void {
    this.connected = false;
    this.tools = [];
  }

  /**
   * Check if client is connected
   */
  isConnected(): boolean {
    return this.connected;
  }
}
