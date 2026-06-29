---
name: twitter-agent
description: Build and run a Twitter/X agent with a distinct personality and automated workflows
emoji: 🐦
tags: [twitter, x, social, agent, automation]
visibility: public
---

# Twitter Agent Skill

This skill provides a framework for creating, managing, and automating a Twitter/X agent with a persistent personality and voice.

## Prerequisites

### X Account Setup (REQUIRED — Do This First)

Before anything else, the agent's X account MUST be marked as an **automated account**. X requires this disclosure for any account posting with API automation; skipping it is the fastest way to get the account suspended.

**Exact path (do this once, while logged in as the agent account):**
1. Log in to x.com as the agent account.
2. Go to **Settings and privacy** → **Your account** → **Account information**.
3. Scroll to **Automation** and tap it.
4. Re-enter the password when prompted.
5. Set **Managing account** to the human/handle responsible for the bot and save.

Direct link: https://x.com/settings/account/automation

This adds the "Automated by @…" label to the profile and replies. It is non-negotiable — do not run this skill against an account that has not been labeled.

### Environment Variables

Set these 4 variables in your environment. Generate them from the [X Developer Portal](https://developer.x.com/en/portal/dashboard) with **Read and Write** permissions enabled:

- `X_API_KEY`: Consumer Key (OAuth 1.0a)
- `X_API_KEY_SECRET`: Consumer Secret
- `X_ACCESS_TOKEN`: User Access Token
- `X_ACCESS_TOKEN_SECRET`: User Access Token Secret

### Approval Channel for Automations

When creating automations, route flagged drafts to Telegram for human approval. No env vars needed — just link your Telegram to your Bankr account and select Telegram as the output when setting up each automation.

## The Personality & Storyline System

Every agent requires two files to maintain a consistent voice and narrative:

1. `twitter-personality.md`: Defines the character, voice, and style rules.
2. `twitter-storyline.md`: Tracks the ongoing narrative, recent events, and current state of the character.

### Building a Personality

If no personality file exists, the agent should walk the user through creating one by asking:

1. "what's the account about? give me the elevator pitch"
2. "how would you describe the vibe? pick a few: sharp, witty, degen, serious, chaotic, chill, academic, edgy, wholesome, provocative, technical, meme-heavy"
3. "what topics do you want to tweet about? what's strictly off-limits?"
4. "short punchy tweets or longer form? threads?"
5. "emojis? hashtags? lowercase or proper grammar?"
6. "any signature phrases or words you always use?"
7. "give me 2-3 example tweets that sound like you -- or accounts you want to sound like"
8. "is there a character or persona the account should tweet as? or is it just you?"

After gathering answers, the agent composes the personality file and saves it as `twitter-personality.md`.

### Pre-Flight Checklist

Before composing or posting any tweet, the agent MUST:
1. Load `twitter-personality.md` using `read_file`.
2. Load `twitter-storyline.md` using `read_file` to understand the current narrative context.
3. Filter the proposed content through the personality directives and ensure it continues the storyline.
4. Cross-reference all drafted content against the storyline file to prevent repeating jokes, themes, or phrases already used.
5. Run the Guardrail Check (see below) before any post -- manual OR automated.
6. After posting, update `twitter-storyline.md` with the new tweet and any narrative developments using `edit_file` (NOT `create_file` -- see File Management below).

## Guardrails (CRITICAL -- Apply to Manual AND Automated Posts)

These apply to every tweet the agent drafts, whether running manually or on a schedule. A draft that violates any of these routes to approval instead of posting.

### Never Reply Unprompted (Hard Rule)

The agent MUST NEVER reply to a post it was not invited into. An agent that cold-replies to strangers' timelines is the single fastest path to an X suspension. There are exactly three legal post types:

1. **Top-level posts** composed by the agent itself.
2. **Replies to mentions** — only when the agent's handle is *explicitly* tagged in the tweet text (case-insensitive `@handle` token in `text`, not merely an `in_reply_to_user_id` match).
3. **Replies to comments on the agent's own posts** — i.e. replies where `in_reply_to_user_id` is the agent's own user ID AND the parent tweet in the conversation tree is authored by the agent.

Anything outside those three categories is FORBIDDEN and must be dropped from the draft set before the guardrail check even runs.

Mention-scan filter (enforce in the fetch step):
- Keep a mention only if `text` contains the agent's `@handle` as a standalone token.
- OR keep it if `in_reply_to_user_id === agentUserId` AND the root of `conversation_id` is authored by the agent.
- Discard everything else before ranking.

### Hard Blocks (Always Route to Approval)

1. **Never autonomously tag `@bankrbot`.** Any tweet mentioning `@bankrbot` MUST be drafted and surfaced for approval.
2. **Never post onchain-action-looking content autonomously.** If a draft contains an EVM address, a Solana address, "send" combined with a ticker, or anything that reads like a transaction instruction -- route to approval.
3. **Never post pre-declared arc milestones autonomously.** Check storyline file's `## Approval-Gated Milestones` section.
4. **Never engage autonomously with flagged accounts.** Check storyline file's `## Approval-Gated Accounts` section.

### Follower-Weighted Approval

- Replies to accounts with **>50k followers** route to approval.
- Replies to accounts with **1k-50k followers** post autonomously if they clear all other guardrails.
- Replies to accounts with **<1k followers** post autonomously only if the setup quality is strong.

### Skip List (Automations Filter These Out Entirely)

Automations should never engage with:
- FUD / rug accusations
- Political content
- Requests for financial advice
- Obvious spam / tag-farm threads (3+ unrelated @s stacked)
- Accounts shilling unrelated tokens
- Any mention the storyline marks as already-replied-to

## Reply Workflow

When the user asks to check mentions and reply, follow this exact sequence:

### Step 1: Scan Mentions
Use `execute_cli` with `twitter-api-v2@1.17.2` to fetch recent mentions. The scan script should:
- Fetch mentions via `userMentionTimeline`
- Include author follower counts for prioritization
- Flag which mentions reply to which of our tweets
- Mark tweets we've already replied to (cross-reference with storyline file)
- **Apply the "Never Reply Unprompted" filter**: keep only tweets where the agent is explicitly tagged in `text`, OR replies on the agent's own conversation tree. Drop everything else before ranking.

### Step 2: Read Storyline File
Load `twitter-storyline.md` BEFORE drafting any replies. Check:
- Which tweets/mentions have already been replied to (by tweet ID)
- What jokes, themes, and phrases have already been used
- What the current narrative state is
- Approval-gated milestones + approval-gated accounts

### Step 3: Prioritize Mentions
Filter and rank unreplied mentions using this hierarchy:
1. **High-follower accounts first** (10k+ followers = high priority for reach)
2. **Good setup lines** (mentions that give a natural opening for an in-character reply)
3. **Easy layups** (simple mentions that can be answered with a quick voice-consistent one-liner)
4. **Skip**: the full Skip List above

### Step 4: Draft Replies + Optional New Post
- Draft 4-6 replies per batch
- Optionally draft 1 new top-level tweet per session
- Cross-reference EVERY draft against the storyline file to ensure no overlap
- Run Guardrail Check on every draft
- Present all drafts to the user for approval before posting (manual mode)

### Step 5: Post & Update
- Only post after explicit approval
- Post all approved tweets via `execute_cli` (rate-limit ~1.5s between posts)
- Update `twitter-storyline.md` with all new entries using `edit_file`

## File Management

### CRITICAL: Use edit_file, Not create_file
When updating `twitter-storyline.md`, ALWAYS use `edit_file` with the existing file ID. Using `create_file` will spawn duplicate files.

### Storyline File Structure
The storyline file should maintain:
- **Current State**: Location, mood, current objective, environment/context
- **Narrative History**: Chronological entries with tweet IDs, content, and narrative impact
- **Key Characters & Objects**: All recurring elements in the lore
- **Storyline Threads to Continue**: Active plot threads for future tweets
- **Approval-Gated Milestones**: Upcoming arc-critical posts that must never be auto-posted
- **Approval-Gated Accounts**: Accounts whose interactions always require approval
- **Pending Approval Queue**: Drafts sent to Telegram awaiting human review

## Technical Implementation

All Twitter interactions use `execute_cli` with the `twitter-api-v2@1.17.2` package.

### Posting Pattern

```javascript
const { TwitterApi } = require('twitter-api-v2');

const client = new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_KEY_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
});

// Post a tweet
const tweet = await client.v2.tweet('your personality-filtered text');
console.log('Tweet ID:', tweet.data.id);

// Reply to a tweet
await client.v2.reply('reply text', originalTweetId);

// Get user timeline
const timeline = await client.v2.userTimeline(userId);
```

### Mention Scanning Pattern

```javascript
const me = await client.v2.me();
const mentions = await client.v2.userMentionTimeline(me.data.id, {
  max_results: 50,
  expansions: ['author_id', 'in_reply_to_user_id', 'referenced_tweets.id'],
  'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id', 'referenced_tweets', 'text', 'public_metrics'],
  'user.fields': ['username', 'name', 'public_metrics']
});

const myHandle = me.data.username.toLowerCase();
const myId = me.data.id;
const tagRegex = new RegExp(`(^|[^a-zA-Z0-9_])@${myHandle}([^a-zA-Z0-9_]|$)`, 'i');

const eligible = (mentions.data.data || []).filter(t => {
  const explicitlyTagged = tagRegex.test(t.text || '');
  const isReplyOnOurTree = t.in_reply_to_user_id === myId;
  return explicitlyTagged || isReplyOnOurTree;
});
```

### execute_cli Configuration

- packages: `["twitter-api-v2@1.17.2"]`
- includeEnvVars: `true` (critical -- this injects the X API keys)
- timeoutMs: `30000`
- runtime: use `bun script.js` (NOT `node`)

## Troubleshooting

- **403 Forbidden**: App doesn't have Write permissions. Enable Read and Write in the X Developer Portal.
- **401 Unauthorized**: Keys are wrong or expired. Regenerate in X Developer Portal.
- **429 Too Many Requests**: Rate limited. Free tier = ~50 tweets/day. Wait and retry.
- **Duplicate tweet**: X rejects identical text. Add variation.
- **`node: command not found`**: Sandbox uses bun. Use `bun script.js` instead of `node script.js`.

## Best Practices

- **Label the account as automated first**: https://x.com/settings/account/automation
- **Never reply unprompted**: Only reply when explicitly tagged or when someone comments on the agent's own post.
- **Manual first, automate later**: Run the skill manually 5-10 times before enabling any automation.
- **Narrative Continuity**: Treat the agent's life as a persistent world. Reference previous events naturally.
- **Cross-Reference Before Posting**: Read the storyline file before every drafting session.
- **Rate Limits**: Free tier allows ~50 tweets/day. Space out automated posts.
