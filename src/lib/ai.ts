import { createOpenAI } from "@ai-sdk/openai";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENAI_API_KEY && !OPENROUTER_API_KEY) {
  throw new Error(
    "No LLM credentials. Set OPENAI_API_KEY (preferred) or OPENROUTER_API_KEY in .env.",
  );
}

export const PROVIDER: "openai" | "openrouter" = OPENAI_API_KEY
  ? "openai"
  : "openrouter";

const client = OPENAI_API_KEY
  ? createOpenAI({ apiKey: OPENAI_API_KEY })
  : createOpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: OPENROUTER_API_KEY,
    });

export const MODEL_ID =
  PROVIDER === "openai"
    ? (process.env.OPENAI_MODEL ?? "gpt-4o-mini")
    : (process.env.OPENROUTER_MODEL ?? "moonshotai/kimi-k2");

export const model = client(MODEL_ID);

console.log(`[ai] provider=${PROVIDER} model=${MODEL_ID}`);
