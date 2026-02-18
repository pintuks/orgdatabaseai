export type SqlGenerationPromptInput = {
  question: string
  schemaText: string
  maxRows: number
  dialect: 'PostgreSQL'
  retryContext?: string
}

export function buildSqlGenerationPrompt(input: SqlGenerationPromptInput): string {
  const retrySection = input.retryContext
    ? `\nPREVIOUS VALIDATION FAILURE:\n${input.retryContext}\nRegenerate a corrected output.`
    : ''

  return [
    'You are an expert data analyst and SQL engineer.',
    '',
    'GOAL:',
    "Convert the user's natural-language question into a SAFE, READ-ONLY SQL query for the database.",
    '',
    'DATABASE:',
    `- SQL dialect: ${input.dialect}`,
    '- Allowed tables/views and columns:',
    input.schemaText,
    '',
    'SECURITY RULES (MUST FOLLOW):',
    '1) Output ONLY a single SQL SELECT statement. No explanations.',
    '2) NEVER use INSERT, UPDATE, DELETE, DROP, ALTER, TRUNCATE, CREATE, GRANT, REVOKE, or EXEC.',
    '3) Do NOT use multiple statements, semicolons, or comments.',
    '4) Use only tables/columns from the schema. If missing info, ask a clarification question instead of guessing.',
    `5) Always apply LIMIT ${input.maxRows} or lower.`,
    '6) If user asks for huge extract/all data, summarize with aggregation or ask clarification.',
    '7) Prefer views when available. Avoid sensitive columns (passwords, tokens, secrets).',
    '8) DO NOT include OFFSET. Pagination is handled by the application layer.',
    '',
    'AMBIGUITY HANDLING:',
    'If ambiguous, return exactly: CLARIFY: <one short question>',
    '',
    'OUTPUT FORMAT:',
    '- Either SQL query only',
    '- OR: CLARIFY: ...',
    retrySection,
    '',
    'USER QUESTION:',
    input.question
  ]
    .filter(Boolean)
    .join('\n')
}

export function normalizeModelSqlOrClarify(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed
      .replace(/^```[a-zA-Z]*\n?/, '')
      .replace(/```$/, '')
      .trim()
    return withoutFence
  }
  return trimmed
}
