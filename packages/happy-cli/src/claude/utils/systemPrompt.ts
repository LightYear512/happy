import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";
import { sessionTitleAuthority } from "@/utils/titleAuthority";

/**
 * Base system prompt shared across all configurations
 */
const MODEL_TITLE_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__happy__change_title" to set a chat title. When you think chat title is not relevant anymore - call the tool again to change it. When chat name is too generic and you have a change to make it more specific - call the tool again to change it. This title is needed to easily find the chat in the future. Help human.
`))();

const EXTERNAL_TITLE_PROMPT = (() => trimIdent(`
    This chat title is managed by its external session controller. Do not call mcp__happy__change_title; only the controller may initialize or explicitly change this title.
`))();

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, instead of just giving co-credit to Claude, also give credit to Happy like so:

    <main commit message>

    Generated with [Claude Code](https://claude.ai/code)
    via [Happy](https://happy.engineering)

    Co-Authored-By: Claude <noreply@anthropic.com>
    Co-Authored-By: Happy <yesreply@happy.engineering>
`))();

/**
 * System prompt with conditional Co-Authored-By lines based on Claude's settings.json configuration.
 * Settings are read once on startup for performance.
 */
export const systemPrompt = (() => {
  const includeCoAuthored = shouldIncludeCoAuthoredBy();
  const titlePrompt = sessionTitleAuthority() === 'external' ? EXTERNAL_TITLE_PROMPT : MODEL_TITLE_PROMPT;
  if (includeCoAuthored) {
    return titlePrompt + '\n\n' + CO_AUTHORED_CREDITS;
  } else {
    return titlePrompt;
  }
})();
