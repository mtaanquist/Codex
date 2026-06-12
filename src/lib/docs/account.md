# Your account

Open your account page from the avatar menu in the top bar. It has four
sections: Profile, Security, Assistant, and Display. Changes save when you
select the save button in each block.

## Profile

Set your display name and, if you like, a separate pen name to show on your
public pages. The public-page block is where you claim a handle: a short name
that becomes your public address at `/@yourhandle`. You can claim a handle once,
so pick it with care. Add a short bio and, if you take requests, a note that
your commissions are open with the details. Turn on the public profile toggle to
show this page to visitors; leave it off to keep it hidden.

You can upload an avatar when image storage is set up on the instance. Without
it, your initials stand in.

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
- **Models per role**: pick which model handles each kind of help. Select Discover
  models to fill the lists from your endpoint, choose one per role, then save. Roles
  with no model chosen fall back to the endpoint's default. A single story can
  override these too. When the list is long, type part of a name in the filter box
  to narrow it; models you already picked always stay listed. If your endpoint
  publishes prices (OpenRouter does), each model shows what it costs per million
  tokens sent and received.
- **Usage**: every request the Assistant sends to your endpoint is listed here
  with the token counts the endpoint reported, plus a 30-day total. When prices
  are known, an estimated cost shows too. The list shows 50 requests at a time;
  use Older and Newer to page through the rest. Only counts are kept; the text
  itself is never stored in this log.

Your words are sent only to the endpoint you set here.

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
- **Daily word goal**: a daily word target. The Session tab and the Insights
  page show how close you are to it. Leave it blank for no goal.

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
