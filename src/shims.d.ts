declare module "yaml" {
  export function parse(input: string): any;
}

declare module "minimatch" {
  export function minimatch(path: string, pattern: string, options?: any): boolean;
}

declare module "node:fs" {
  export function readFileSync(path: string, encoding: string): string;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
}

declare module "@mariozechner/pi-coding-agent" {
  export type ExtensionAPI = any;
}
