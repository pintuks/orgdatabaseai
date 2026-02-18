export function buildClarifyPrompt(question: string, schemaText: string): string {
  return [
    'You are a product analyst. The user asked a database question that is ambiguous.',
    'Ask exactly ONE clarifying question that will let us write a correct SQL query.',
    'Be brief.',
    '',
    'User question:',
    question,
    '',
    'Schema:',
    schemaText
  ].join('\n')
}
