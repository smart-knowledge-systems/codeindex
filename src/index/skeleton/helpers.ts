export function firstNLines(content: string, n: number): string {
  return content.split("\n").slice(0, n).join("\n");
}
