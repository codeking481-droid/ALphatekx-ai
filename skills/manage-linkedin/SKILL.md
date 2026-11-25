---
name: manage-linkedin
description: Draft and manage LinkedIn posts, comments, replies, and people searches for the connected account.
version: 1.0.0
permissions:
  - tool:read
  - tool:approved
tools:
  - linkedin_post
  - linkedin_read_comments
  - linkedin_reply
  - linkedin_search_people
---

## When to use

Use when the signed-in user asks to draft or publish a LinkedIn post, read post comments, reply to a comment, or search for people.

## Steps

1. Draft a concise post or reply from facts provided by the user; do not invent claims, credentials, or results.
2. Before posting or replying, show the exact proposed text and call the matching approval-required tool. The action appears in Approvals and must not be described as published until approval succeeds.
3. Use `linkedin_read_comments` only for a post the connected account can access. Summarize comments faithfully and distinguish commenter statements from verified facts.
4. Use `linkedin_search_people` only for the user's explicit search request and return a small, relevant set of public results.
5. If LinkedIn reports that the app lacks API access or permissions, explain that restriction plainly; do not retry through another account or endpoint.

## Examples

- For “Post on LinkedIn: AlphaTekx is live,” prepare the exact post text, request `linkedin_post`, and wait for the user's approval in Approvals.
- For “Read comments on this post,” request the post URN if it is missing, then use `linkedin_read_comments`.
- For “Reply to this comment,” draft the reply and use `linkedin_reply`; wait for approval before claiming it was sent.

## What not to do

- Never publish a post or reply without explicit user approval.
- Never claim a post, reply, comment, or search succeeded unless the tool confirms it.
- Do not collect, infer, or expose private profile data or credentials.
- Do not bypass LinkedIn's API permissions, access restrictions, rate limits, or user consent.
