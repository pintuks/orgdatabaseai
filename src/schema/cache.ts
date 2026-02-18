import type { Pool } from 'pg'
import type { Logger } from 'pino'
import { formatSchemaForPrompt, introspectSchema, type SchemaSnapshot } from './introspect'

export class SchemaRegistry {
  private snapshot: SchemaSnapshot | null = null
  private promptSchemaText: string | null = null
  private refreshHandle: NodeJS.Timeout | null = null

  constructor(
    private readonly pool: Pool,
    private readonly refreshSec: number,
    private readonly logger: Logger
  ) {}

  async init(): Promise<void> {
    await this.refresh()

    this.refreshHandle = setInterval(() => {
      this.refresh().catch((error) => {
        this.logger.error({ error }, 'failed to refresh schema cache')
      })
    }, this.refreshSec * 1000)

    this.refreshHandle.unref()
  }

  async refresh(): Promise<void> {
    const nextSnapshot = await introspectSchema(this.pool)
    this.snapshot = nextSnapshot
    this.promptSchemaText = formatSchemaForPrompt(nextSnapshot)

    this.logger.info(
      {
        tableCount: nextSnapshot.tables.length,
        refreshedAt: nextSnapshot.refreshedAtIso
      },
      'schema cache refreshed'
    )
  }

  getSnapshot(): SchemaSnapshot {
    if (!this.snapshot) {
      throw new Error('Schema cache is not initialized')
    }

    return this.snapshot
  }

  getPromptSchemaText(): string {
    if (!this.promptSchemaText) {
      throw new Error('Schema cache is not initialized')
    }

    return this.promptSchemaText
  }

  stop(): void {
    if (this.refreshHandle) {
      clearInterval(this.refreshHandle)
      this.refreshHandle = null
    }
  }
}
