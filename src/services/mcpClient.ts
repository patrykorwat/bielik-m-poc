import { spawn, ChildProcess } from 'child_process';

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

/**
 * MCP Client for communicating with MCP servers via JSON-RPC
 */
export class MCPClient {
  private serverProcess: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: any) => void;
  }>();
  private buffer = '';
  private initialized = false;
  private tools: MCPTool[] = [];

  constructor(private serverCommand: string, private serverArgs: string[]) {}

  /**
   * Start the MCP server and initialize connection
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.serverProcess = spawn(this.serverCommand, this.serverArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        if (!this.serverProcess.stdout || !this.serverProcess.stdin) {
          throw new Error('Failed to create server process');
        }

        // Handle stdout data
        this.serverProcess.stdout.on('data', (data: Buffer) => {
          this.buffer += data.toString();
          this.processBuffer();
        });

        // Handle stderr (server logs)
        this.serverProcess.stderr?.on('data', (data: Buffer) => {
          console.log('[MCP Server]', data.toString());
        });

        // Handle process errors
        this.serverProcess.on('error', (error) => {
          console.error('MCP server error:', error);
          reject(error);
        });

        // Handle process exit
        this.serverProcess.on('exit', (code) => {
          console.log('MCP server exited with code:', code);
        });

        // Wait a bit for server to start, then initialize
        setTimeout(async () => {
          try {
            await this.initialize();
            await this.listTools();
            resolve();
          } catch (error) {
            reject(error);
          }
        }, 500);
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Process incoming JSON-RPC messages from buffer
   */
  private processBuffer(): void {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line);

        // Handle response
        if ('id' in message && message.id !== undefined) {
          const pending = this.pendingRequests.get(message.id);
          if (pending) {
            this.pendingRequests.delete(message.id);

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
   * Send JSON-RPC request to MCP server
   */
  private async sendRequest(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.serverProcess?.stdin) {
        reject(new Error('MCP server not connected'));
        return;
      }

      const id = ++this.requestId;
      const request = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.pendingRequests.set(id, { resolve, reject });

      try {
        this.serverProcess.stdin.write(JSON.stringify(request) + '\n');
      } catch (error) {
        this.pendingRequests.delete(id);
        reject(error);
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error('MCP request timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Initialize MCP connection
   */
  private async initialize(): Promise<void> {
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'bielik-m-poc',
        version: '1.0.0',
      },
    });

    this.initialized = true;
    console.log('MCP initialized:', result);
  }

  /**
   * List available tools from MCP server
   */
  async listTools(): Promise<MCPTool[]> {
    const result = await this.sendRequest('tools/list', {});
    this.tools = result.tools || [];
    return this.tools;
  }

  /**
   * Get cached tools
   */
  getTools(): MCPTool[] {
    return this.tools;
  }

  /**
   * Call a tool on the MCP server
   */
  async callTool(name: string, args: Record<string, any>): Promise<MCPToolResult> {
    if (!this.initialized) {
      throw new Error('MCP client not initialized');
    }

    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    return result;
  }

  /**
   * Disconnect from MCP server
   */
  disconnect(): void {
    if (this.serverProcess) {
      this.serverProcess.kill();
      this.serverProcess = null;
    }
    this.initialized = false;
    this.tools = [];
    this.pendingRequests.clear();
  }

  /**
   * Check if client is connected and initialized
   */
  isConnected(): boolean {
    return this.initialized && this.serverProcess !== null;
  }
}
