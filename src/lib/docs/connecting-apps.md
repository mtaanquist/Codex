# Connecting an app

If you already use an AI app, such as Claude, you can connect it to Codex. The app can then read your stories and your world, and leave suggestions and comments for you. You stay in charge: a connected app can never change, delete or publish your writing. Everything it leaves waits for you to accept or turn down.

Connecting an app is separate from the Assistant inside Codex. You do not need to set up the Assistant to connect an app, and connecting an app does not change how the Assistant works.

## Before you start

You need two things:

- An app that can add a custom connector. Some apps call this a remote MCP server. Claude on the web and the Claude desktop app both can; check your app's settings if you are not sure.
- A Codex that the app can reach. If you sign in to Codex at a normal web address that starts with `https://`, you are set. If you run Codex only on your own computer, an app that runs on the internet cannot reach it; see "If the app cannot connect" below.

## Connect the app

1. In Codex, open the account menu at the top right and select Account, then Connected apps.
2. Under "Allow other apps to connect", type your password, and the code from your authenticator app if you use two-factor authentication, then select "Turn on access for apps". Nothing can connect while this is off.
3. Select Copy next to "Address to give the app".
4. In your app, open its settings and find where connectors are added. Choose to add a custom connector, give it a name such as Codex, and paste the address. In Claude this is under Settings, then Connectors. The names of these menus differ between apps and change over time.
5. The app opens a Codex page in your browser. Sign in if you are asked to.
6. Check the name and the web address of the app shown on the page. If you did not start this yourself, select "Do not allow".
7. Choose what the app may do, then select Allow.

The app is now connected. You are sent back to it, and it appears under "Apps with access" in Codex.

## What an app may do

You choose this on the page where you allow the app:

- **Read your writing.** Your universes, stories, scenes, characters, places and lore. This is always included. A story where you have turned the Assistant off stays hidden from apps too, and so does anything in the trash.
- **Leave suggestions and comments.** Untick this if you want the app to read only.

No app can change your text, delete anything, publish a story, or see another person's writing.

## Ask the app to do something

Talk to the app the way you normally do, and mention Codex. For example:

- "Read chapter two of my story in Codex and tell me where the pacing drags."
- "Copyedit the scene called The Quay in Codex and leave your edits there."
- "Who is Old Marit? Check my Codex."

Codex also gives the app a set of ready-made requests for the work the Assistant does: review, copyedit, continuity review, pattern pass, write, rewrite, draft, draft a chapter, catch me up, a character or place sheet, and search. Where they show up depends on the app; look for a list of prompts or commands from Codex. Pick one and fill in what it asks for.

## Find what the app left

Nothing the app leaves changes your writing until you decide.

- **Suggested edits and comments** are in the story's Review. Accept or reject each one, and reply to a comment if you want to talk it over; the app can read your reply the next time you ask it to look. See [Inviting a reviewer](/docs/reviewing) for how Review works.
- **A note about a habit that repeats**, such as a pet phrase, comes with a link. Open the link to go through its edits one at a time.
- **Suggested characters, places and lore entries**, and **proposals to split a scene in two**, are in the universe's settings under Suggestions. See [Planning your world](/docs/planning).
- **A draft the app wrote for a scene** waits on that scene. Open the scene and select the Assistant tab on the right to read it, change it, and keep or discard it. A universe holds up to 20 drafts from apps at a time; keep or discard some to make room for more. See [Writing in the editor](/docs/editor).

Each of these shows the name of the app that left it.

## Disconnect an app

Open Account, then Connected apps. Under "Apps with access", select Disconnect next to the app. It stops working at once. What it already left stays for you to decide on.

To disconnect every app at once, turn off "Allow other apps to connect". To use an app again afterwards, turn access on again with your password, then connect the app again.

Changing or resetting your password also disconnects every app. Access stays on, so afterwards you only need to connect each app again.

## For a script or tool of your own

A tool that cannot open the Codex page to ask for access can use a personal access token instead. See "Personal access tokens" in [Your account](/docs/account).

## If the app cannot connect

- **"Connected apps" is missing from your account page.** The person who runs your Codex has turned this off. Ask them to turn it on.
- **The app says it cannot reach the address.** Apps that run on the internet, including Claude on the web and the Claude desktop app, connect from their own servers, not from your computer. They can only reach a Codex that has a public web address starting with `https://`. A Codex that you open at `localhost`, or at an address that only works at home, cannot be reached by them. If you run Codex yourself, see [Running Codex yourself](/docs/selfhosting).
- **The Codex page shows an error instead of asking you to allow the app.** Remove the connector in the app and add it again with the address copied from Connected apps. If the page says "This request cannot be answered", the app sent a request Codex could not use; select the link to return to the app, or go to your library if you did not start this yourself.
- **The app stopped working.** Check "Apps with access". If the app is not listed, it was disconnected, for example by a password change. Connect it again.
- **The app cannot see one of your stories.** Check that the Assistant is not turned off for that story, and that the story is not in the trash.
- **The app says there are too many calls.** Wait a minute and ask again. Codex limits how fast an app may work.
