import { z } from 'zod'

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'lowest-usage'])
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>

/**
 * Kiro effort levels control thinking/reasoning depth.
 * - low: minimal reasoning
 * - medium: balanced (default when thinking enabled)
 * - high: deeper reasoning
 * - xhigh: extended reasoning (xhigh-capable models only, see effort.ts)
 * - max: maximum reasoning depth (up to 128k thinking tokens on opus-4.8/opus-5)
 */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortSchema>

export const RegionSchema = z.enum([
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'af-south-1',
  'ap-east-1',
  'ap-south-2',
  'ap-southeast-3',
  'ap-southeast-5',
  'ap-southeast-4',
  'ap-south-1',
  'ap-southeast-6',
  'ap-northeast-3',
  'ap-northeast-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-east-2',
  'ap-southeast-7',
  'ap-northeast-1',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-south-1',
  'eu-west-3',
  'eu-south-2',
  'eu-north-1',
  'eu-central-2',
  'il-central-1',
  'mx-central-1',
  'me-south-1',
  'me-central-1',
  'sa-east-1'
])
export type Region = z.infer<typeof RegionSchema>

export const KiroConfigSchema = z.object({
  $schema: z.string().optional(),

  idc_start_url: z.string().url().optional(),
  idc_region: RegionSchema.optional(),
  idc_profile_arn: z.string().optional(),

  account_selection_strategy: AccountSelectionStrategySchema.default('lowest-usage'),

  default_region: RegionSchema.default('us-east-1'),

  rate_limit_retry_delay_ms: z.number().min(1000).max(60000).default(5000),

  rate_limit_max_retries: z.number().min(0).max(10).default(3),

  max_request_iterations: z.number().min(5).max(1000).default(20),

  request_timeout_ms: z.number().min(30000).max(600000).default(120000),

  token_expiry_buffer_ms: z.number().min(30000).max(300000).default(300000),

  usage_sync_max_retries: z.number().min(0).max(5).default(3),

  auth_server_port_start: z.number().min(1024).max(65535).default(19847),

  auth_server_port_range: z.number().min(1).max(100).default(10),

  usage_tracking_enabled: z.boolean().default(true),
  auto_sync_kiro_cli: z.boolean().default(true),
  enable_log_api_request: z.boolean().default(false),

  /**
   * Default effort level for thinking models. Controls reasoning depth.
   * When set, this overrides the automatic budget-based mapping.
   * Values: 'low', 'medium', 'high', 'xhigh' (see XHIGH_CAPABLE_MODELS), 'max'
   */
  effort: EffortSchema.optional(),

  /**
   * Enable automatic effort mapping from OpenCode's thinking budget.
   * When true (default), maps budget ranges to effort levels.
   * When false, only uses explicit effort config or falls back to 'medium'.
   */
  auto_effort_mapping: z.boolean().default(true),

  // When conversationState.history still exceeds Kiro's entry limit after folding
  // tool loops, condense the oldest turns into a text transcript inside the first
  // user turn instead of dropping them. Off by default (drop the oldest turns).
  compress_overflow_history: z.boolean().default(false),

  // Upper bound on conversationState.history entries sent to Kiro. Kiro rejects 200+
  // entries as "Input is too long"; 198 is the largest verified size. Raise only if
  // Kiro raises its limit. Mirrors KIRO_CONSTANTS.MAX_HISTORY_ENTRIES.
  max_history_entries: z.number().int().min(10).max(10000).default(198),

  // Low-water mark for max_history_entries. Once history exceeds the limit it is trimmed
  // down to this size in one step, so the cut point (and Kiro's cacheable prompt prefix)
  // stays fixed for many turns instead of moving every turn. Values at or above
  // max_history_entries trim only what is needed. Mirrors KIRO_CONSTANTS.HISTORY_TRIM_TARGET.
  history_trim_target: z.number().int().min(10).max(10000).default(150),

  // compress_overflow_history only: per-item character caps for old tool results and
  // tool call inputs written into the transcript. Longer text keeps its head and tail
  // around a truncation marker. 0 disables the cap.
  compress_tool_result_max_chars: z.number().int().min(0).max(1000000).default(8000),
  compress_tool_input_max_chars: z.number().int().min(0).max(1000000).default(4000),

  // compress_overflow_history only: save the full text of each truncated transcript item
  // under OpenCode's tool-output directory and point the truncation marker at it.
  compress_save_truncated_output: z.boolean().default(true),

  // Expose Kiro's server-side web search as a `kiro_web_search` tool. Kiro runs
  // the search on its own infrastructure (billed as Kiro credits) and returns
  // structured results. Requires a Pro account (profileArn); on free Builder ID
  // accounts the tool is not registered. Disable to avoid overlap with other
  // search tools/MCP servers.
  web_search_enabled: z.boolean().default(true)
})

export type KiroConfig = z.infer<typeof KiroConfigSchema>

export const DEFAULT_CONFIG: KiroConfig = {
  account_selection_strategy: 'lowest-usage',
  default_region: 'us-east-1',
  rate_limit_retry_delay_ms: 5000,
  rate_limit_max_retries: 3,
  max_request_iterations: 20,
  request_timeout_ms: 120000,
  token_expiry_buffer_ms: 300000,
  usage_sync_max_retries: 3,
  auth_server_port_start: 19847,
  auth_server_port_range: 10,
  usage_tracking_enabled: true,
  auto_sync_kiro_cli: true,
  enable_log_api_request: false,
  auto_effort_mapping: true,
  compress_overflow_history: false,
  max_history_entries: 198,
  history_trim_target: 150,
  compress_tool_result_max_chars: 8000,
  compress_tool_input_max_chars: 4000,
  compress_save_truncated_output: true,
  web_search_enabled: true
}
