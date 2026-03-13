import { readFile } from "fs/promises";

export interface Config {
  host: string;
  port: number;
}

export class Server {
  private port: number;

  constructor(port: number) {
    this.port = port;
  }

  async start(): Promise<void> {
    console.log(`Listening on ${this.port}`);
  }
}

export async function loadConfig(path: string): Promise<Config> {
  const data = await readFile(path, "utf-8");
  return JSON.parse(data);
}

export type UserId = string | number;

export enum LogLevel {
  Debug = "debug",
  Info = "info",
  Error = "error",
}

export const DEFAULT_PORT = 3000;
