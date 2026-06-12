/**
 * Shared constants and shell script generators for tab-completion.
 *
 * This module MUST remain lightweight (no registry, no discovery imports).
 * Both completion.ts (full path) and completion-fast.ts (manifest path) import from here.
 */

/**
 * Built-in (non-dynamic) top-level commands.
 */
export const BUILTIN_COMMANDS = [
  'list',
  'validate',
  'verify',
  'browser',
  'tab',
  'doctor',
  'plugin',
  'external',
  'completion',
];

// ── Shell script generators ────────────────────────────────────────────────

export function bashCompletionScript(): string {
  return `# Bash completion for bycli
# Add to ~/.bashrc:  eval "$(bycli completion bash)"
_bycli_completions() {
  local cur words cword
  _get_comp_words_by_ref -n : cur words cword

  local completions
  completions=$(bycli --get-completions --cursor "$cword" "\${words[@]:1}" 2>/dev/null)

  COMPREPLY=( $(compgen -W "$completions" -- "$cur") )
  __ltrim_colon_completions "$cur"
}
complete -F _bycli_completions bycli
`;
}

export function zshCompletionScript(): string {
  return `# Zsh completion for bycli
# Add to ~/.zshrc:  eval "$(bycli completion zsh)"
_bycli() {
  local -a completions
  local cword=$((CURRENT - 1))
  completions=(\${(f)"$(bycli --get-completions --cursor "$cword" "\${words[@]:1}" 2>/dev/null)"})
  compadd -a completions
}
compdef _bycli bycli
`;
}

export function fishCompletionScript(): string {
  return `# Fish completion for bycli
# Add to ~/.config/fish/config.fish:  bycli completion fish | source
complete -c bycli -f -a '(
  set -l tokens (commandline -cop)
  set -l cursor (count (commandline -cop))
  bycli --get-completions --cursor $cursor $tokens[2..] 2>/dev/null
)'
`;
}
