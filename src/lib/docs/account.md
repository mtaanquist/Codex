# Your account

Open your account page from the avatar menu at the top right of any page. It has four
sections: Profile, Security, Assistant, and Display. Changes save on their own:
a choice saves as soon as you make it, and a text field saves when you leave it.
A "Saved." note confirms each save.

## Profile

Set your display name and, if you like, a separate pen name to show on your
public pages. The public-page block is where you claim a handle: a short name
that becomes your public address at `/@yourhandle`. You can claim a handle once,
so pick it with care. Add a short bio and, if you take requests, a note that
your commissions are open with the details. Turn on the public profile toggle to
show this page to visitors; leave it off to keep it hidden. Either way, "Open
your page" next to the page address shows you the page as visitors would see
it; while it is hidden, a note on top says only you can see it.

You can upload an avatar when image storage is set up on the instance. Without
it, your initials stand in.

## Invites

When an admin has given your account invites, an Invites section appears in
the sidebar. Select "Generate an invite" to make a code, then "Copy link" to
get a sign-up link to send your friend. Each code admits one person, who can
sign in as soon as their email is confirmed. Revoke a code that has not been
used to take it back; that frees the invite so you can generate another.

The public page and avatar only appear to visitors once an admin has enabled
publishing for your account and your profile is set to public.

## Assistant

The Assistant is an optional writing helper that connects to a language-model
endpoint you choose and control. It is off until you turn it on, and it never
contacts a model on its own.

- **Kill switch**: the switch at the top turns the whole Assistant on or off. While
  it shows "Assistant off", nothing you write is ever sent to a model. Turn it off
  to use the Assistant; turn it back on to stop everything at once. The settings
  below are dimmed while the Assistant is off.
- **Identity**: give the Assistant a name and pick a style for how it writes back.
  The name shows wherever the Assistant appears.
- **Endpoint**: pick a provider from the list and paste an API key from that
  provider's website; the link under the picker takes you to the right page to
  create one. The base URL fills in by itself for these. Leave the key blank to
  keep the one already saved. Select Test connection to send a short message and
  see the model reply.
  - **Claude (Anthropic)**: create a key in the Anthropic console. A Claude.ai
    subscription (Pro or Max) is not an API key; API use is billed separately
    through the console, where you add credit first.
  - **ChatGPT (OpenAI)**: create a key on the OpenAI platform under API keys.
    Add billing details or credit there before the key will answer.
  - **Gemini (Google)**: create a key in Google AI Studio with a Google
    account. A free tier is available, with stricter rate limits.
  - **DeepSeek**: create a key on the DeepSeek platform under API keys and top
    up credit there.
  - **OpenRouter**: one key gives access to models from many makers, including
    all of the above. Create a key on openrouter.ai and add credit; this is the
    easiest way to try different models without holding several accounts.
  - **Custom endpoint**: enter the base URL of any OpenAI-compatible endpoint
    yourself, such as a local Ollama server (for example
    `http://localhost:11434/v1`). Local endpoints usually need no key, and your
    text never leaves your machine.
- **Tools offered**: while it works, the Assistant can read scenes from your
  stories and hand back suggested edits and comments. Leave this on All tools for
  a large hosted model. Pick Fewer tools if your model is small or runs on your
  own machine: it is then offered only the three it needs most (read a scene,
  suggest an edit, leave a comment), and it stops sooner instead of retrying,
  which smaller models handle far more reliably.
- **Spend cap per review**: the most one background review may spend before it
  stops. It checks between scenes, so it never stops half way through one, and it
  tells you how far it got and what it spent. To carry on, either raise the cap
  and run it again, or run the same review again as it is: a run over the same
  scope (the same chapter, or the same whole story) skips the scenes the stopped
  run already read and starts from a fresh budget. Leave the box empty for no cap.
  This needs your endpoint to publish prices for the model; without a price the
  review says the cap could not be applied rather than stopping or ignoring it.
- **Warn above**: before a chapter or whole-story review starts, the review window
  shows what it will send and, where a price is known, what that costs. Above this
  figure it asks you to confirm again. Leave the box empty for the default of
  2.00.
- **Models per role**: pick which model handles each kind of help. Select Discover
  models to fill the lists from your endpoint, then choose one per role. The roles
  are Rubber duck (the side panel), Co-author (passages you can insert),
  Continuation (inline suggestions), Reviewer (suggested edits on a draft), and
  Background work (scene and chapter summaries, suggested entity details, and the
  story recap). Roles with no model chosen fall back to the model you picked for
  Rubber duck, or to the endpoint's default. A single story can
  override these too. When the list is long, type part of a name in the filter box
  to narrow it; models you already picked always stay listed. If your endpoint
  publishes prices (OpenRouter does), each model shows what it costs per million
  tokens sent and received.
- **Context window**: how much text a model can take in one request, counted in
  tokens. Each model you have picked for a role gets a box under the role list.
  Discover models fills the number in when your endpoint reports one, and the
  number shows next to the model in the lists. Type your own number to override
  it; what you type is kept the next time you discover models. Empty the box to
  go back to the reported value. If you run the model yourself, enter the size
  you started the server with (llama.cpp calls this the context size), not the
  largest the model could handle: that setting is what actually applies.
- **Thinking**: each role has a Thinking list with three settings. On asks the
  model to reason before it answers: noticeably better reviews and feedback, at
  the cost of more tokens and a slower reply. Off tells the endpoint to skip that
  step, which is what you want for Continuation, Co-author, and Background work,
  where waiting is worse than a slightly plainer answer. Default leaves your
  endpoint to do whatever it already does. On the Claude provider, Off does the
  same thing as Default: Claude models decide for themselves whether to think, so
  the setting only ever turns thinking on.
- **Temperature**: on any endpoint other than Claude, each role has a temperature
  box, from 0 to 2. Lower keeps the model close to the most likely wording, which
  is what you want for the Reviewer (around 0.2) and for Background work, where
  the answer should stick to the text. Higher lets it wander, which can suit the
  Co-author. Leave the box empty to use your endpoint's own setting. The Claude
  API is driven by the thinking and effort settings instead, so no temperature box
  shows there.
- **Longest reply**: the most a model may write in one go, counted in tokens, set
  per role. Raise it for a role whose answers get cut off mid-sentence, or lower
  it to keep a model brief. Leave the box empty to use the length Codex asks for,
  which suits most setups.
- **Extra request settings**: some endpoints take settings Codex has no box for,
  and each server spells them its own way. The box under Endpoint holds JSON that
  is sent with every request, for example `{"top_p": 0.9}`. Each role has a box of
  its own too, laid over the endpoint one, for when a single role needs something
  different, such as a switch that turns reasoning off for the Reviewer. Check
  your server's documentation for what it accepts, and leave both empty if you are
  not sure: nothing here is needed for a normal setup. Test connection sends the
  endpoint ones too, so you can check your server accepts them. Codex sets the model,
  messages, tools, reply length, and streaming itself, so those cannot be
  overridden. This does not show on the Claude provider, which is driven by the
  thinking and effort settings instead.
- **Effort (Claude only)**: with the Claude provider, each role also has an effort
  list. Effort sets how hard the model works on each request, from low (fast and
  cheap) to max (thorough and expensive); leave it unset to use the model's
  default. A good starting point: thinking on with high effort for the reviewer,
  everything unset for continuation so suggestions stay fast. Not every model
  accepts every level ("xhigh" needs a recent Opus model, and small models may
  reject effort entirely); if a request starts failing after a change here, clear
  the effort for that role.
- **Usage**: every request the Assistant sends to your endpoint is listed here
  with the token counts the endpoint reported, plus a 30-day total. When prices
  are known, an estimated cost shows too. With the Claude provider, repeated
  context (your world details, earlier turns) is cached by the API and billed
  far cheaper on reuse; the log counts cached tokens as sent, so the estimate
  errs on the high side. The list shows 50 requests at a time;
  use Older and Newer to page through the rest. Only counts are kept; the text
  itself is never stored in this log.

Your words are sent only to the endpoint you set here.

### Which model to pick for each role

The roles want different things, so a single model for all five is rarely the
best you can do. Each role in the list shows a short suggestion; here is the
longer version.

Continuation, Co-author, and Background work want speed above all. Continuation
runs while you type, and a suggestion that arrives after you have written the
next line is worthless. Background work runs summaries, entity details, and
recaps in bulk. Hosted, Claude Haiku is the cheap fast choice. On your own
machine, look for a mixture-of-experts instruct model such as Qwen3 30B A3B
(search for "MoE instruct GGUF"). A mixture-of-experts model holds many
parameters but uses only a small slice of them per word, so it answers far
faster than its size suggests, as long as it fits in memory. Turn thinking off
for all three.

The Reviewer wants the strongest model you can run, since it reads a whole draft
and has to be right about what it quotes. Hosted, Claude Sonnet. On your own
machine, a dense 32B instruct model such as Qwen3 32B (search for "32B instruct
GGUF"). Dense means every parameter is used for every word: slower than a
mixture-of-experts model of the same size, but steadier at close reading. Set a
low temperature so it quotes your text faithfully instead of paraphrasing it;
thinking is worth turning on here if you can afford the wait.

Rubber duck is the one role with no technical requirement. Pick whichever model
you enjoy talking to.

## Display

Choose a light, warm, or dark theme, or follow your system, and pick an accent
colour from the swatches or a custom one. The warm theme is a softer, sunlit
version of the light one. When you follow your system, two extra choices let you
set which theme is used while your system is light and which is used while it is
dark. The change applies across the app right away.

## Editor

How the writing area works, as your personal defaults.

- **Writing appearance**: the font and line spacing of the writing area. Choose
  Custom for the font and type the name of a font installed on your device; if it
  is not found, the default writing font is used. Choose Custom for line spacing
  to set the line height in centimetres. This is separate from Page setup, so you
  can write in one font on screen and export in another.
- **Editor behaviour**: turn entity autocomplete on or off, show or hide the
  scene marks in the continuous view, show or hide the writing streak, and set
  spell-check and your writing language. There is also a choice between the
  markdown editor and the softer rich editing surface.
- **Daily word goal**: a daily word target. A universe's Insights page shows how
  close you are to it. Leave it blank for no goal.

## Notifications

What reaches you, and where: the bell in the top bar, email, both, or neither,
for each kind of event. Emails arrive batched, so a busy hour sends one message.

## Page setup

How print and PDF output is typeset: page size, margins, font, paragraph style,
line spacing, default text alignment, and scene-break text. For the font, choose
Custom and type the name of a font installed on the reading device; if it is not
found, the default font is used. For line spacing, choose Custom to set the line
height in centimetres. The default text alignment applies to paragraphs that do
not carry their own alignment marker, and also shows while you write.

These are your defaults. Any single story can set its own and fall back to these
with a "use my account setting" option.

## Getting your work out

The Security section has two ways to take your work with you. Export prepares a
single zip of everything you own: every universe, story, scene, entity, note,
and uploaded image, all as markdown. It is built in the background and appears
ready to download a moment later (a bell notification tells you when). Delete
removes your account and everything in it. See
[keeping your account secure](/docs/security) for both.
