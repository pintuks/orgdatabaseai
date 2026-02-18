export type ResultExplanationPromptInput = {
  question: string
  sql: string
  rowsJson: string
  mayBeTruncated: boolean
}

export function buildResultExplanationPrompt(input: ResultExplanationPromptInput): string {
  return [
    'You are a helpful assistant that explains database query results clearly and accurately.',
    '',
    'RULES:',
    '1) Do NOT invent data. Use only the rows provided.',
    '2) If rows are empty, say so and suggest what filter might be missing.',
    '3) Keep the answer short and direct (max 2 sentences).',
    '4) Do NOT repeat row-by-row values, bullet lists of records, or markdown tables because UI already shows tabular data.',
    '5) If the user asked for a number (count/sum/avg), show the number prominently.',
    '6) If results are truncated due to a row limit, mention that.',
    '',
    'USER QUESTION:',
    input.question,
    '',
    'SQL YOU RAN:',
    input.sql,
    '',
    'ROWS (JSON):',
    input.rowsJson,
    '',
    `RESULT TRUNCATED: ${input.mayBeTruncated ? 'YES' : 'NO'}`,
    '',
    'Now write the answer for the user.'
  ].join('\n')
}
