Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Ordered rotation: ChatGPT -> Gemini -> Claude -> wrap.
# Selectors are best-effort, browser-only DOM heuristics (no vendor API is used anywhere).
# Each entry mirrors the shape ChatGPT already used: a generic contenteditable/textarea
# composer, a single unambiguous Send control, and a login/notice heuristic. Sites differ
# in exact markup, so every provider also accepts common generic fallbacks, the same way
# the original ChatGPT-only implementation already tolerated markup drift.
$script:YtProviderTable = [ordered]@{
    ChatGPT = [pscustomobject]@{
        Name = 'ChatGPT'
        Url = 'https://chatgpt.com/'
        Hosts = @('chatgpt.com')
        ResultHost = 'chatgpt.com'
        ResultPathPattern = '^/c/[A-Za-z0-9_-]+$'
        EditorSelectors = @('#prompt-textarea', 'textarea[placeholder*="Chat"]', 'textarea[placeholder*="Message"]', '[contenteditable="true"][role="textbox"]')
        SendSelectors = @('button[data-testid="send-button"]', 'button[data-composer-submit]', 'button[aria-label*="Send"]', 'button[type="submit"]')
        StopSelectors = @('button[data-testid="stop-button"]')
        LoginSelectors = @('a[href*="/auth/login"]', 'button[data-testid="login-button"]')
        UserMessageSelector = '[data-message-author-role="user"]'
        AssistantMessageSelector = '[data-message-author-role="assistant"]'
        AssistantTextSelector = '.markdown'
        ErrorSelector = '.text-token-text-error,[data-testid*="error"]'
    }
    Gemini = [pscustomobject]@{
        Name = 'Gemini'
        Url = 'https://gemini.google.com/app'
        Hosts = @('gemini.google.com')
        ResultHost = 'gemini.google.com'
        ResultPathPattern = '^/app/[A-Za-z0-9_-]+$'
        EditorSelectors = @('rich-textarea .ql-editor', 'div.ql-editor[contenteditable="true"]', 'textarea[aria-label*="Message"]', '[contenteditable="true"][role="textbox"]')
        # Gemini localises every aria-label, so an English "Send" match finds nothing on a
        # Hebrew (or any other non-English) account and the prompt is pasted and never sent.
        # The Material icon name is the same in every language, so it leads. Observed live:
        # <button class="mdc-icon-button ..." aria-label="שליחת הודעה"><mat-icon data-mat-icon-name="arrow_upward">
        SendSelectors = @(
            'button:has(mat-icon[data-mat-icon-name="send"])',
            'button:has(mat-icon[data-mat-icon-name="arrow_upward"])',
            'button[aria-label*="Send message"]', 'button.send-button', 'button[aria-label*="Send"]')
        StopSelectors = @('button:has(mat-icon[data-mat-icon-name="stop"])', 'button[aria-label*="Stop response"]', 'button[aria-label*="Stop"]')
        LoginSelectors = @('a[href*="ServiceLogin"]', 'a[aria-label*="Sign in"]')
        UserMessageSelector = 'user-query'
        AssistantMessageSelector = 'model-response'
        AssistantTextSelector = '.markdown, message-content'
        ErrorSelector = '.error-message,[data-error]'
    }
    Claude = [pscustomobject]@{
        Name = 'Claude'
        Url = 'https://claude.ai/new'
        Hosts = @('claude.ai')
        ResultHost = 'claude.ai'
        ResultPathPattern = '^/chat/[A-Za-z0-9_-]+$'
        EditorSelectors = @('div.ProseMirror[contenteditable="true"]', '[contenteditable="true"][role="textbox"]')
        SendSelectors = @('button[aria-label*="Send Message"]', 'button[aria-label*="Send message"]')
        StopSelectors = @('button[aria-label*="Stop"]')
        LoginSelectors = @('a[href*="/login"]', 'button[data-testid="login-button"]')
        UserMessageSelector = '[data-testid="user-message"]'
        AssistantMessageSelector = '[data-testid="assistant-message"], .font-claude-message'
        AssistantTextSelector = '.standard-markdown, .prose'
        ErrorSelector = '[data-testid="error-banner"],[role="alert"]'
    }
}

# Canonical rotation order: ChatGPT -> Gemini -> Claude -> wrap.
$script:YtRotationOrder = [string[]]@('ChatGPT', 'Gemini', 'Claude')

function Get-YtProviderOrder {
    return [string[]]$script:YtRotationOrder
}

function Get-YtProvider {
    param([Parameter(Mandatory)][ValidateSet('ChatGPT', 'Gemini', 'Claude')][string]$Name)
    return $script:YtProviderTable[$Name]
}

function Get-YtProviderIndex {
    param([Parameter(Mandatory)][string]$Name)
    $index = [Array]::IndexOf($script:YtRotationOrder, $Name)
    if ($index -lt 0) { throw "Unknown provider: $Name" }
    return $index
}

function Get-YtProviderByIndex {
    param([Parameter(Mandatory)][ValidateRange(0, 2)][int]$Index)
    return $script:YtProviderTable[$script:YtRotationOrder[$Index]]
}

function Get-YtNextProviderIndex {
    param([Parameter(Mandatory)][ValidateRange(0, 2)][int]$Index)
    return ($Index + 1) % $script:YtRotationOrder.Count
}

function Get-YtEnabledProviderOrder {
    param([AllowNull()][string[]]$EnabledProviders)
    if ($null -eq $EnabledProviders) { return [string[]]$script:YtRotationOrder }
    $invalid = @($EnabledProviders | Where-Object { $_ -notin $script:YtRotationOrder })
    $duplicates = @($EnabledProviders | Group-Object | Where-Object Count -gt 1)
    if ($EnabledProviders.Count -eq 0 -or $invalid.Count -gt 0 -or $duplicates.Count -gt 0) {
        throw 'Enabled providers must be a non-empty unique subset of ChatGPT, Gemini, and Claude.'
    }
    return [string[]]@($script:YtRotationOrder | Where-Object { $_ -in $EnabledProviders })
}

function Get-YtNextEnabledProviderIndex {
    param(
        [Parameter(Mandatory)][ValidateRange(0, 2)][int]$Index,
        [Parameter(Mandatory)][string[]]$EnabledProviders
    )
    $enabled = Get-YtEnabledProviderOrder $EnabledProviders
    for ($offset = 1; $offset -le $script:YtRotationOrder.Count; $offset++) {
        $candidate = ($Index + $offset) % $script:YtRotationOrder.Count
        if ($script:YtRotationOrder[$candidate] -in $enabled) { return $candidate }
    }
    throw 'No enabled provider is available.'
}

# Rejection phrases that must be treated as a *definite* usage/concurrency rejection
# regardless of which provider produced them, in addition to each provider's own notice
# heuristics. These are generic, commonly-observed browser-facing phrases.
$script:YtDefiniteUsagePhrases = @(
    'too many requests',
    "you.{0,3}re making requests too (?:quickly|fast)",
    'temporarily limited',
    "you.{0,3}ve? (?:hit|reached).{0,40}(?:limit|cap)",
    '(?:usage|message|daily|rate|request).{0,30}(?:limit|cap)',
    'out of (?:messages|credits)',
    'limit resets'
)

# Banners that match the usage phrases above but that observation shows do NOT stop the
# assistant from answering. ChatGPT's "we've temporarily limited access to your
# conversations to protect your data" throttles the conversation *list*, not generation:
# the prompt is still answered normally. Treating it as a rejection abandoned working
# summaries and rotated for no reason, so it is explicitly downgraded to healthy.
$script:YtBenignBannerPhrases = @(
    'limited access to your conversations',
    'protect your data'
)

function Test-YtBenignBanner {
    <#
      True when provider text matches a rate-limit phrase that observation shows does not
      actually stop the assistant from answering. Applies to every provider: ChatGPT, Gemini
      and Claude all render conversation-list/session throttling banners next to a perfectly
      normal answer.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $false }
    foreach ($pattern in $script:YtBenignBannerPhrases) {
        if ($Text -imatch $pattern) { return $true }
    }
    return $false
}

$script:YtDefiniteSizePhrases = @(
    '(?:message|text|prompt|input|context).{0,100}(?:too long|exceed|maximum|length limit)',
    'too many tokens',
    'maximum.{0,40}(?:length|context)'
)

$script:YtDefiniteUnavailablePhrases = @(
    'currently unavailable',
    'service is at capacity',
    'over capacity',
    'no (?:models?|capacity) (?:is |are )?available',
    'a fresh (?:chatgpt|gemini|claude) conversation did not become available',
    '(?:chatgpt|gemini|claude) did not accept the full text or enable send',
    '(?:chatgpt|gemini|claude) accepted the full text but never enabled send',
    # This provider tab cannot be used safely right now, but another provider still can be.
    # These must rotate instead of failing the whole video.
    'contains an existing draft',
    'is already generating a response',
    'opened an existing conversation'
)

function Get-YtFailureClassification {
    <#
      Classifies free text found on a provider page after a send into:
        'usage'       - definite usage/rate/concurrency rejection -> rotate immediately, no cooldown
        'size'        - definite size/length rejection -> rotate immediately, no cooldown
        'unavailable' - definite service-unavailable rejection -> rotate immediately, no cooldown
        'service'     - ambiguous post-send service noise (not necessarily a rejection)
        ''             - no classification (healthy)
      'usage', 'size' and 'unavailable' are all "definite" failures for rotation purposes.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Text, [switch]$Explicit)
    if ([string]::IsNullOrWhiteSpace($Text)) { return '' }
    if (Test-YtBenignBanner $Text) { return '' }
    foreach ($pattern in $script:YtDefiniteSizePhrases) {
        if ($Text -imatch $pattern) { return 'size' }
    }
    foreach ($pattern in $script:YtDefiniteUsagePhrases) {
        if ($Text -imatch $pattern) { return 'usage' }
    }
    foreach ($pattern in $script:YtDefiniteUnavailablePhrases) {
        if ($Text -imatch $pattern) { return 'unavailable' }
    }
    if ($Explicit -or $Text -imatch 'something went wrong|error generating|failed to generate|network error') { return 'service' }
    return ''
}

function Test-YtDefiniteRejection {
    param([string]$Classification)
    return $Classification -in @('usage', 'size', 'unavailable')
}

Export-ModuleMember -Function Get-YtProviderOrder, Get-YtProvider, Get-YtProviderIndex, Get-YtProviderByIndex,
    Get-YtNextProviderIndex, Get-YtEnabledProviderOrder, Get-YtNextEnabledProviderIndex,
    Get-YtFailureClassification, Test-YtDefiniteRejection, Test-YtBenignBanner
