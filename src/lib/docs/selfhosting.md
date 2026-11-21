# Running Codex yourself

Codex can run on a computer you look after, instead of on one somebody else looks after for you. That is what self-hosting means: the app runs on your own machine or your own server, and everything you write is stored there.

There are two ways to use Codex, and they are the same app.

- **Hosted.** Someone else runs Codex and you sign in to it. Nothing to install, nothing to keep up to date.
- **Self-hosted.** You run Codex yourself. Your writing lives on your machine, and nobody else has a copy unless you make one.

Every feature works the same either way: the same editor, the same planning tools, the same reading pages, the same exports. You can move your work between the two whenever you like, because everything you write leaves as markdown files and comes back in through the story import. See "Getting started" for where the export and import live.

## What it takes

Codex needs a machine that stays on when you want to use it, a Postgres database, and a web address if you want to reach it from anywhere but that machine. The steps and the commands live with the project's code, in its README, because they change as the app does. Follow those and you will have Codex running.

If none of that sounds like something you want to do, use a hosted Codex instead. Nothing in the app is held back for people who self-host, and nothing is held back for people who do not.

## Connecting AI apps

People with an account can connect an AI app they use, such as Claude, so it can read their writing and leave suggestions; see [Connecting an app](/docs/connecting-apps). Apps that run on the internet connect from their own servers, so they can only reach a Codex that has a public web address starting with `https://`. A Codex that only answers on your own computer or your home network cannot be reached by them. If you run Codex for others and do not want this at all, turn it off in the admin panel.

## Running it for other people

A Codex you run can hold accounts for other people, each with their own writing. Whoever runs it decides who gets in: nobody, invited people only, people who ask and get approved, or anybody who signs up. If you are the one running it, that setting is in the admin panel.
