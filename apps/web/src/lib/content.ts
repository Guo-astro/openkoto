// Public content (docs, changelog, legal) bundled as markdown via Vite `?raw`.
// Files are named `<slug>.<lang>.md` (lang = en | zh | ja); English is the fallback.

export type ContentLang = "en" | "zh" | "ja";

export interface ContentDoc {
  slug: string;
  lang: ContentLang;
  title: string;
  description?: string;
  date?: string;
  tags: string[];
  body: string;
}

type RawModules = Record<string, string>;

const docsRaw = import.meta.glob("../content/docs/*.md", { query: "?raw", import: "default", eager: true }) as RawModules;
const updatesRaw = import.meta.glob("../content/updates/*.md", { query: "?raw", import: "default", eager: true }) as RawModules;
const legalRaw = import.meta.glob("../content/legal/*.md", { query: "?raw", import: "default", eager: true }) as RawModules;

/** Minimal frontmatter parser: `key: value` lines between `---` fences. */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, body: raw };
  const data: Record<string, string> = {};
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    data[key] = value;
  }
  return { data, body: raw.slice(match[0].length) };
}

function load(modules: RawModules): ContentDoc[] {
  return Object.entries(modules).flatMap(([path, raw]) => {
    const m = /\/([^/]+)\.(en|zh|ja)\.md$/.exec(path);
    const slug = m?.[1];
    if (!m || !slug) return [];
    const { data, body } = parseFrontmatter(raw);
    return [
      {
        slug,
        lang: m[2] as ContentLang,
        title: data.title ?? slug,
        description: data.description,
        date: data.date,
        tags: data.tags ? data.tags.split(",").map((s) => s.trim()).filter(Boolean) : [],
        body,
      },
    ];
  });
}

const docs = load(docsRaw);
const updates = load(updatesRaw);
const legal = load(legalRaw);

export function contentLang(language: string | undefined): ContentLang {
  const l = (language ?? "").toLowerCase();
  if (l.startsWith("zh")) return "zh";
  if (l.startsWith("ja")) return "ja";
  return "en";
}

function pick(list: ContentDoc[], slug: string, lang: ContentLang): ContentDoc | undefined {
  return list.find((d) => d.slug === slug && d.lang === lang) ?? list.find((d) => d.slug === slug && d.lang === "en");
}

function slugs(list: ContentDoc[]): string[] {
  return [...new Set(list.map((d) => d.slug))];
}

/** Sidebar order for the docs; unknown slugs are appended alphabetically. */
const DOC_ORDER = ["index", "google-ai-studio", "302ai", "kimi-k2"];

export function listDocs(lang: ContentLang): ContentDoc[] {
  const all = slugs(docs).sort((a, b) => {
    const ia = DOC_ORDER.indexOf(a);
    const ib = DOC_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
  return all.map((s) => pick(docs, s, lang)!);
}

export function getDoc(slug: string, lang: ContentLang): ContentDoc | undefined {
  return pick(docs, slug, lang);
}

/** Changelog entries, newest first. */
export function listUpdates(lang: ContentLang): ContentDoc[] {
  return slugs(updates)
    .map((s) => pick(updates, s, lang)!)
    .sort((a, b) => (b.date ?? b.slug).localeCompare(a.date ?? a.slug));
}

export function getLegal(kind: "privacy" | "terms", lang: ContentLang): ContentDoc | undefined {
  return pick(legal, kind, lang);
}
