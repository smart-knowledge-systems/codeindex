import { Parser, Language } from "web-tree-sitter";
import type { SupportedLanguage } from "./types";
import { GRAMMAR_WASM, RUNTIME_WASM } from "./wasm-assets";

let parserInitialised = false;
const languageCache = new Map<string, Language>();

export async function initParser(): Promise<void> {
  if (parserInitialised) return;
  await Parser.init({ locateFile: () => RUNTIME_WASM });
  parserInitialised = true;
}

export async function loadLanguage(lang: SupportedLanguage): Promise<Language> {
  const cached = languageCache.get(lang);
  if (cached) return cached;

  const language = await Language.load(GRAMMAR_WASM[lang]);
  languageCache.set(lang, language);
  return language;
}
