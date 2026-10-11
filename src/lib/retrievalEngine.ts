import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import Cerebras from '@cerebras/cerebras_cloud_sdk';
import { getBhumiVikasRules, localSemanticSearch, type BhumiVikasRule } from './rulesData';

// Ensure .env is read
dotenv.config();

export interface AskRequest {
  query: string;
  language: 'en' | 'hi';
}

export interface AskResponse {
  answer: string;
  rule_number: string;
  page_number: string;
  exact_text_excerpt: string;
  rule_found: boolean;
  version_note: string;
  // Metadata for clerk visibility
  meta?: {
    retrieval_mode: 'cerebras_subsecond' | 'local_semantic';
    llm_engine: 'claude-sonnet-4-6' | 'local_deterministic';
    latency_ms: number;
    cerebras_latency_ms?: number;
    claude_latency_ms?: number;
  };
}

export async function processClerkQuery(req: AskRequest): Promise<AskResponse> {
  const startTime = Date.now();
  const query = (req.query || '').trim();
  const language = req.language === 'hi' ? 'hi' : 'en';

  if (!query) {
    return {
      answer: language === 'hi' 
        ? 'कृपया भवन अनुज्ञा से संबंधित वैध प्रश्न दर्ज करें।' 
        : 'Please enter a valid query regarding building permission rules.',
      rule_number: 'N/A',
      page_number: 'N/A',
      exact_text_excerpt: 'N/A',
      rule_found: false,
      version_note: 'Consolidated up to 6 March 2025',
      meta: {
        retrieval_mode: 'local_semantic',
        llm_engine: 'local_deterministic',
        latency_ms: 1,
      },
    };
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || '';
  const cerebrasApiKey = process.env.CEREBRAS_API_KEY?.trim() || '';

  const allRules = getBhumiVikasRules();
  let retrievedRule: BhumiVikasRule | null = null;
  let cerebrasLatencyMs: number | undefined = undefined;
  let retrievalMode: 'cerebras_subsecond' | 'local_semantic' = 'local_semantic';

  // --- Step 1: Sub-Second Semantic Retrieval using Cerebras Inference API ---
  if (cerebrasApiKey && cerebrasApiKey.length > 5 && !cerebrasApiKey.includes('your_')) {
    const cerebrasStart = Date.now();
    try {
      const cerebras = new Cerebras({ apiKey: cerebrasApiKey });
      const ruleIndexCatalog = allRules
        .map((r) => `${r.rule_number}: ${r.title} | Keywords: ${r.keywords.join(', ')} | Summary: ${r.summary}`)
        .join('\n');

      const cerebrasPrompt = `You are a sub-second semantic retrieval engine for Bhopal Municipal Corporation (BMC) Building Permission Rules (MP Bhumi Vikas Rules 2012).
Rules Catalog:
${ruleIndexCatalog}

User Query: "${query}"

Task:
Identify which single Rule Number (e.g. "Rule 52", "Rule 77", "Rule 59", etc.) directly governs this query.
If the query is irrelevant, outside building bylaws, or not covered in the rules, output matched_rule_number as null.

Output JSON only in this format:
{"matched_rule_number": "Rule XX" | null, "confidence": number, "reason": "brief reason"}`;

      const cerebrasResponse = await cerebras.chat.completions.create({
        model: 'gpt-oss-120b',
        messages: [
          { role: 'system', content: 'You are an ultra-fast semantic index router. Output valid JSON only.' },
          { role: 'user', content: cerebrasPrompt },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
        max_tokens: 150,
      });

      cerebrasLatencyMs = Date.now() - cerebrasStart;
      retrievalMode = 'cerebras_subsecond';

      const content = cerebrasResponse.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);
      if (parsed.matched_rule_number) {
        const found = allRules.find(
          (r) => r.rule_number.toLowerCase() === String(parsed.matched_rule_number).toLowerCase().trim()
        );
        if (found) {
          retrievedRule = found;
        }
      }
    } catch (err) {
      console.warn('[Cerebras Retrieval Warning]', err);
      // Fallback to local semantic search if Cerebras call encounters issue
    }
  }

  // Fallback to local semantic search if Cerebras not run or didn't match
  if (!retrievedRule) {
    const localMatches = localSemanticSearch(query, 1);
    if (localMatches.length > 0 && localMatches[0].score >= 15) {
      retrievedRule = localMatches[0].rule;
    }
  }

  // --- Step 2: Synthesis with Claude 3.5 Sonnet (claude-3-5-sonnet-20241022) ---
  let claudeLatencyMs: number | undefined = undefined;

  if (anthropicApiKey && anthropicApiKey.length > 5 && !anthropicApiKey.includes('your_')) {
    const claudeStart = Date.now();
    try {
      const anthropic = new Anthropic({ apiKey: anthropicApiKey });

      const systemPrompt = `You are the official legal and technical assistant for Bhopal Municipal Corporation (BMC) Building Permission Clerks, interpreting Madhya Pradesh Bhumi Vikas Rules 2012 (Consolidated up to 6 March 2025).

You MUST output strictly valid JSON matching this schema:
{
  "answer": "Clear short answer in language requested",
  "rule_number": "Rule XX",
  "page_number": "PDF Page XX",
  "exact_text_excerpt": "Exact rule quote...",
  "rule_found": boolean,
  "version_note": "Consolidated up to 6 March 2025"
}

CRITICAL MANDATORY INSTRUCTIONS:
1. IF rule_found is false, you MUST force the "answer" field to explicitly state:
"Rule Silent / Not Found in MP Bhumi Vikas Rules 2012"
Set "rule_number": "N/A", "page_number": "N/A", and "exact_text_excerpt": "N/A".
2. IF the provided candidate rule covers the user's question, set "rule_found": true.
Provide a clear, authoritative, concise clerk answer tailored to language requested ("en" for English, "hi" for Hindi/हिंदी).
Include the exact rule number, PDF page number, and direct verbatim excerpt from the text in "exact_text_excerpt".
3. Always maintain "version_note": "Consolidated up to 6 March 2025".
4. Output valid JSON and nothing else.`;

      const candidateContext = retrievedRule
        ? `Rule Number: ${retrievedRule.rule_number}
Title: ${retrievedRule.title} (${retrievedRule.title_hi})
Chapter: ${retrievedRule.chapter}
Page: ${retrievedRule.page_number}
Summary: ${retrievedRule.summary}
Full Official Text:
${retrievedRule.text}`
        : 'NO MATCHING RULE FOUND IN CATALOG.';

      const userMessage = `User Query: "${query}"
Language: "${language}"

Candidate Rule Context:
${candidateContext}`;

      const claudeResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        temperature: 0.1,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      claudeLatencyMs = Date.now() - claudeStart;

      const firstBlock = claudeResponse.content[0];
      let jsonText = '';
      if (firstBlock && firstBlock.type === 'text') {
        jsonText = firstBlock.text.trim();
      }

      // Parse JSON from Claude response
      const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed: AskResponse = JSON.parse(jsonMatch[0]);

        // Enforce required constraint: if rule_found is false
        if (!parsed.rule_found) {
          parsed.answer = 'Rule Silent / Not Found in MP Bhumi Vikas Rules 2012';
          parsed.rule_number = 'N/A';
          parsed.page_number = 'N/A';
          parsed.exact_text_excerpt = 'N/A';
        }

        parsed.version_note = 'Consolidated up to 6 March 2025';
        parsed.meta = {
          retrieval_mode: retrievalMode,
          llm_engine: 'claude-sonnet-4-6',
          latency_ms: Date.now() - startTime,
          cerebras_latency_ms: cerebrasLatencyMs,
          claude_latency_ms: claudeLatencyMs,
        };

        return parsed;
      }
    } catch (err) {
      console.warn('[Claude Call Warning]', err);
    }
  }

  // --- Step 3: Deterministic High-Fidelity Engine (When keys not provided or offline) ---
  if (!retrievedRule) {
    return {
      answer: 'Rule Silent / Not Found in MP Bhumi Vikas Rules 2012',
      rule_number: 'N/A',
      page_number: 'N/A',
      exact_text_excerpt: 'N/A',
      rule_found: false,
      version_note: 'Consolidated up to 6 March 2025',
      meta: {
        retrieval_mode: retrievalMode,
        llm_engine: 'local_deterministic',
        latency_ms: Date.now() - startTime,
        cerebras_latency_ms: cerebrasLatencyMs,
      },
    };
  }

  // Construct answer from retrieved rule
  const answerEn = `${retrievedRule.title}: ${retrievedRule.summary}`;
  const answerHi = `${retrievedRule.title_hi}: ${retrievedRule.summary}`;

  return {
    answer: language === 'hi' ? answerHi : answerEn,
    rule_number: retrievedRule.rule_number,
    page_number: retrievedRule.page_number,
    exact_text_excerpt: retrievedRule.text,
    rule_found: true,
    version_note: 'Consolidated up to 6 March 2025',
    meta: {
      retrieval_mode: retrievalMode,
      llm_engine: 'local_deterministic',
      latency_ms: Date.now() - startTime,
      cerebras_latency_ms: cerebrasLatencyMs,
    },
  };
}
