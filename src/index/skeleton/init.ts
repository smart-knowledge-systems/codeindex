import path from "path";
import { Parser, Language } from "web-tree-sitter";
import type { SupportedLanguage } from "./types";

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

let parserInitialised = false;
const languageCache = new Map<string, Language>();

export async function initParser(): Promise<void> {
  if (parserInitialised) return;
  await Parser.init();
  parserInitialised = true;
}

const WASM_DIR = path.join(import.meta.dir, "../../../node_modules/tree-sitter-wasms/out");

export async function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const wasmPath = path.join(WASM_DIR, `tree-sitter-${lang}.wasm`);
  const language = await Language.load(wasmPath);
  languageCache.set(lang, language);
  return language;
}
