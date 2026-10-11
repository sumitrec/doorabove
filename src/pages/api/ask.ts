import type { APIRoute } from 'astro';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { getBhumiVikasRules, localSemanticSearch, type BhumiVikasRule } from '../../lib/rulesData';

// Ensure environment variables from .env are loaded
dotenv.config();

export const prerender = false;

interface AskPayload {
  query?: string;
  language?: 'en' | 'hi';
}

interface AskResult {
  answer: string;
  rule_number: string;
  page_number: string;
  exact_text_excerpt: string;
  rule_found: boolean;
  version_note?: string;
  engine?: string;
}

const SYSTEM_PROMPT = `You are the MP Bhumi Vikas Rules 2012 counter assistant for Bhopal Municipal Corporation clerks.

Match the user question against the provided MP Bhumi Vikas Rules 2012 excerpts.
Return strictly valid JSON with keys:
- answer: A short summary of 1-2 sentences max. Do NOT write paragraphs.
- rule_number: e.g. "Rule 56(1)"
- page_number: e.g. "PDF Page 77"
- exact_text_excerpt: The FULL gazetted rule text excerpt as-is. Do NOT edit, shorten, or alter it.
- rule_found: boolean

CRITICAL RULES:
1. CRITICAL LANGUAGE RULE: If the user selects Hindi OR if the user query is written in Hindi/Devanagari, the "answer" field MUST be written in clear, simple Hindi.
2. CRITICAL CONCISENESS RULE: The "answer" field MUST be a short summary of 1-2 sentences max. Do NOT write paragraphs.
3. CRITICAL ACCURACY RULE: Do NOT edit, shorten, or alter the "exact_text_excerpt". Return the FULL gazetted rule text excerpt as-is.
4. STRICT SILENCE RULE: If the query is not explicitly covered in bhumi_vikas_rules.jsonl, set rule_found=false and set answer="Rule Silent / Not Found in MP Bhumi Vikas Rules 2012".`;

export const POST: APIRoute = async ({ request }) => {
  try {
    let body: AskPayload;
    try {
      body = await request.json();
    } catch {
      return new Response(
        JSON.stringify({
          answer: 'Rule Silent / Not Found in MP Bhumi Vikas Rules 2012',
          rule_number: 'N/A',
          page_number: 'N/A',
          exact_text_excerpt: 'N/A',
          rule_found: false,
          error: 'Invalid JSON request payload.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const query = (body.query || '').trim();
    // Detect Devanagari/Hindi script in query
    const hasHindiScript = /[\u0900-\u097F]/.test(query);
    const language = (body.language === 'hi' || hasHindiScript) ? 'hi' : 'en';

    if (!query) {
      return new Response(
        JSON.stringify({
          answer: language === 'hi' 
            ? 'कृपया भवन अनुज्ञा नियमों से संबंधित प्रश्न दर्ज करें।' 
            : 'Please enter a query regarding building permission rules.',
          rule_number: 'N/A',
          page_number: 'N/A',
          exact_text_excerpt: 'N/A',
          rule_found: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 1. Read rules from data/bhumi_vikas_rules.jsonl
    const allRules = getBhumiVikasRules();
    const candidateMatches = localSemanticSearch(query, 5);

    // Context preparation: If candidate matches exist, provide them
    let rulesContext = '';
    if (candidateMatches.length > 0) {
      rulesContext = candidateMatches
        .map(
          (m, idx) =>
            `[Candidate ${idx + 1}]\nRule: ${m.rule.rule_number} (${m.rule.title})\nPage: ${m.rule.page_number}\nPart: ${m.rule.part}\nFull Gazette Text:\n${m.rule.text}`
        )
        .join('\n\n---\n\n');
    } else {
      rulesContext = 'No direct candidate rules found for this query in MP Bhumi Vikas Rules 2012.';
    }

    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
    let anthropicResponse: AskResult | null = null;

    // 2. Call Anthropic API if key is present
    if (apiKey && apiKey.length > 15 && !apiKey.includes('your_')) {
      try {
        const anthropic = new Anthropic({ apiKey });
        const userPrompt = `User Question: "${query}"
Language to use for "answer": ${language === 'hi' ? 'Hindi (हिन्दी)' : 'English'}
Query Contains Devanagari: ${hasHindiScript ? 'Yes' : 'No'}

Relevant Excerpts from data/bhumi_vikas_rules.jsonl:
${rulesContext}

Provide JSON strictly following the system rules:
- answer: 1-2 sentences maximum in ${language === 'hi' ? 'clear, simple Hindi' : 'English'}.
- rule_number: Rule number if found, else N/A.
- page_number: PDF page number if found, else N/A.
- exact_text_excerpt: FULL unedited gazette text of the rule as-is.
- rule_found: true if rule explicitly covers the query, false otherwise.`;

        const message = await anthropic.messages.create({
          model: 'claude-sonnet-4-6',
          max_tokens: 3500,
          temperature: 0.1,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        });

        const firstBlock = message.content[0];
        let contentText = '';
        if (firstBlock && firstBlock.type === 'text') {
          contentText = firstBlock.text.trim();
        }

        const jsonMatch = contentText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as AskResult;
          if (!parsed.rule_found) {
            parsed.answer = 'Rule Silent / Not Found in MP Bhumi Vikas Rules 2012';
            parsed.rule_number = 'N/A';
            parsed.page_number = 'N/A';
            parsed.exact_text_excerpt = 'N/A';
          } else {
            // Guarantee full unedited excerpt from dataset if available
            const matchedRule = allRules.find(
              (r) => r.rule_number.toLowerCase() === (parsed.rule_number || '').toLowerCase().trim()
            ) || (candidateMatches.length > 0 ? candidateMatches[0].rule : null);

            if (matchedRule && (!parsed.exact_text_excerpt || parsed.exact_text_excerpt.length < 50)) {
              parsed.exact_text_excerpt = matchedRule.text;
            }
          }
          parsed.engine = 'claude-sonnet-4-6';
          anthropicResponse = parsed;
        }
      } catch (apiError: any) {
        console.warn('[Anthropic API Call]', apiError?.message || apiError);
      }
    }

    if (anthropicResponse) {
      return new Response(JSON.stringify(anthropicResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 3. Graceful Fallback (if API key missing or error)
    if (candidateMatches.length === 0) {
      return new Response(
        JSON.stringify({
          answer: 'Rule Silent / Not Found in MP Bhumi Vikas Rules 2012',
          rule_number: 'N/A',
          page_number: 'N/A',
          exact_text_excerpt: 'N/A',
          rule_found: false,
          engine: 'local_fallback',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const topMatch = candidateMatches[0].rule;
    const answerEn = `${topMatch.title}: Refer to ${topMatch.rule_number} on ${topMatch.page_number} (${topMatch.part}).`;
    const answerHi = `${topMatch.title_hi || topMatch.title}: कृपया ${topMatch.page_number} पर ${topMatch.rule_number} (${topMatch.part}) के विहित प्रावधान देखें।`;

    return new Response(
      JSON.stringify({
        answer: language === 'hi' ? answerHi : answerEn,
        rule_number: topMatch.rule_number,
        page_number: topMatch.page_number,
        exact_text_excerpt: topMatch.text,
        rule_found: true,
        engine: 'local_fallback',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('Error in /api/ask route:', err);
    return new Response(
      JSON.stringify({
        answer: 'Rule Silent / Not Found in MP Bhumi Vikas Rules 2012',
        rule_number: 'N/A',
        page_number: 'N/A',
        exact_text_excerpt: 'N/A',
        rule_found: false,
        error: err?.message || 'Unexpected server error',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export const GET: APIRoute = async () => {
  return new Response(
    JSON.stringify({
      status: 'active',
      service: 'MP Bhumi Vikas Rules 2012 Assistant for Bhopal Municipal Corporation',
      rules_count: getBhumiVikasRules().length,
      model: 'claude-sonnet-4-6',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
};
