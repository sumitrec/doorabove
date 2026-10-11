import fs from 'node:fs';
import path from 'node:path';

export interface BhumiVikasRule {
  rule_number: string;
  rule_raw: string;
  title: string;
  part: string;
  page_number: string;
  page_start: number;
  page_end: number;
  text: string;
  keywords: string[];
}

let cachedRules: BhumiVikasRule[] | null = null;

export function getBhumiVikasRules(): BhumiVikasRule[] {
  if (cachedRules) {
    return cachedRules;
  }

  const filePath = path.resolve(process.cwd(), 'data/bhumi_vikas_rules.jsonl');
  if (!fs.existsSync(filePath)) {
    console.warn(`[RulesData] Warning: File not found at ${filePath}`);
    return [];
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const rules: BhumiVikasRule[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      const rawRule = String(parsed.rule || parsed.rule_number || '').trim();
      const numOnly = rawRule.replace(/^rule\s*/i, '');
      const rule_number = numOnly ? `Rule ${numOnly}` : 'N/A';
      
      const pageStart = parsed.page_start || (parsed.page_number ? parseInt(String(parsed.page_number).replace(/\D+/g, '') || '1', 10) : 1);
      const pageEnd = parsed.page_end || pageStart;
      const page_number = `PDF Page ${pageStart}`;

      const title = parsed.title || '';
      const part = parsed.part || parsed.chapter || '';
      const text = parsed.text || '';
      
      // Auto-extract keywords from title and text
      const keywords: string[] = Array.isArray(parsed.keywords) ? [...parsed.keywords] : [];
      if (title) keywords.push(title);
      
      rules.push({
        rule_number,
        rule_raw: numOnly,
        title,
        part,
        page_number,
        page_start: pageStart,
        page_end: pageEnd,
        text,
        keywords,
      });
    } catch (err) {
      console.error('[RulesData] Error parsing rule line:', err);
    }
  }

  cachedRules = rules;
  return rules;
}

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'am', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'can', 'could', 'should', 'would',
  'may', 'might', 'must', 'will', 'shall', 'and', 'or', 'but', 'if', 'because',
  'as', 'until', 'while', 'of', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'to', 'from', 'up', 'down', 'in', 'out', 'on', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how',
  'all', 'any', 'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'what', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'tell', 'about',
  'rule', 'rules', 'niyam',
  'क्या', 'है', 'हैं', 'था', 'थी', 'थे', 'का', 'के', 'की', 'को', 'में', 'पर',
  'से', 'और', 'या', 'तो', 'भी', 'ने', 'हो', 'सकता', 'सकते', 'सकती', 'कृपया'
]);

export function localSemanticSearch(query: string, topK: number = 5): { rule: BhumiVikasRule; score: number }[] {
  const rules = getBhumiVikasRules();
  if (rules.length === 0) return [];

  const normalizedQuery = query.toLowerCase().trim();
  const rawWords = normalizedQuery.split(/[\s,?.!;:()\[\]"']+/).filter((w) => w.length > 1);
  const meaningfulWords = rawWords.filter((w) => !STOPWORDS.has(w));

  // Explicit out-of-scope check for cryptocurrency, blockchain, bitcoin queries
  if (/crypto|bitcoin|blockchain|ethereum|nft|token\s+mining/i.test(normalizedQuery)) {
    return [];
  }

  const scored = rules.map((rule) => {
    let score = 0;
    const ruleNum = rule.rule_number.toLowerCase();
    const rawNum = rule.rule_raw.toLowerCase();
    const title = rule.title.toLowerCase();
    const part = rule.part.toLowerCase();
    const text = rule.text.toLowerCase();

    // Direct citation match (e.g. "Rule 76", "76")
    if (normalizedQuery.includes(ruleNum)) {
      score += 150;
    } else if (rawNum && meaningfulWords.includes(rawNum)) {
      score += 100;
    }

    // Exact title match in query
    if (title && normalizedQuery.includes(title)) {
      score += 80;
    }

    // Word boundary matching
    for (const word of meaningfulWords) {
      const wordRegex = new RegExp(`(^|[^a-zA-Z0-9\u0900-\u097F])${word}([^a-zA-Z0-9\u0900-\u097F]|$)`, 'i');
      
      if (wordRegex.test(title)) {
        score += 35;
      }
      if (wordRegex.test(part)) {
        score += 15;
      }
      if (wordRegex.test(text)) {
        score += 8;
      }
    }

    // Domain Boosts for specific building scrutiny concepts in MP Bhumi Vikas Rules
    if ((normalizedQuery.includes('setback') || normalizedQuery.includes('mos') || normalizedQuery.includes('सेटबैक')) && (rule.rule_raw === '53' || rule.rule_raw === '56')) {
      score += 50;
    }
    if ((normalizedQuery.includes('200 sqm') || normalizedQuery.includes('200') || normalizedQuery.includes('plot size')) && (rule.rule_raw === '53' || rule.rule_raw === '56')) {
      score += 40;
    }
    if ((normalizedQuery.includes('parking') || normalizedQuery.includes('ecs') || normalizedQuery.includes('पार्किंग')) && rule.rule_raw === '84') {
      score += 60;
    }
    if ((normalizedQuery.includes('basement') || normalizedQuery.includes('तहखाना')) && rule.rule_raw === '76') {
      score += 70;
    }
    if ((normalizedQuery.includes('rainwater') || normalizedQuery.includes('rwh') || normalizedQuery.includes('roof') || normalizedQuery.includes('वर्षा जल')) && rule.rule_raw === '81') {
      score += 60;
    }
    if ((normalizedQuery.includes('boundary') || normalizedQuery.includes('compound wall') || normalizedQuery.includes('चारदीवारी')) && rule.rule_raw === '78') {
      score += 60;
    }
    if ((normalizedQuery.includes('bada talab') || normalizedQuery.includes('upper lake') || normalizedQuery.includes('buffer') || normalizedQuery.includes('water body') || normalizedQuery.includes('तालाब')) && (rule.rule_raw === '50' || rule.rule_raw === '2' || rule.rule_raw === '79')) {
      score += 40;
    }

    return { rule, score };
  });

  const filtered = scored.filter((item) => item.score >= 25);
  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, topK);
}
