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
- **Endpoint**: enter the base URL of any OpenAI-compatible endpoint, such as a
  local Ollama server or a hosted service, and an API key if it needs one. Leave
  the key blank to keep the one already saved. Select Test connection to send a
  short message and see the model reply.
- **Models per role**: pick which model handles each kind of help. Select Discover
  models to fill the lists from your endpoint, choose one per role, then save. Roles
  with no model chosen fall back to the endpoint's default. A single story can
  override these too.

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
