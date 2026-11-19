# Social Hub Privacy Policy

Effective date: November 18, 2026

This policy explains what information **Social Hub** handles and where it goes. Social Hub is open-source software for scheduling and publishing posts to TikTok, Facebook and Instagram.

**In short:** Social Hub runs on its operator's own server. It keeps information only on that server, sends it only to the network a post is going to, and never sends anything to the people who maintain the software or to anyone else.

## 1. Who is responsible

Social Hub is self-hosted. Each copy runs on a server belonging to whoever installs it, the **operator**, who connects their own accounts with their own TikTok and Meta developer apps. The operator controls the information on their server and is responsible for it.

The people who maintain the Social Hub software ("the maintainers") don't run a service and don't receive any information from Social Hub servers. They have no access to any operator's server or the information in it.

## 2. Information Social Hub handles

| Source | What Social Hub receives | Why |
| --- | --- | --- |
| TikTok (Login Kit and Content Posting API) | The connected account's TikTok ID and display name, and access and refresh tokens | To show which account is connected, and to upload videos to it |
| Facebook and Instagram (Meta Graph API) | The connected Facebook Page's ID, name and access token, and the linked Instagram account's ID and username | To publish posts to that Page and Instagram account |
| People using Social Hub | Captions, photos, videos and scheduled times they enter | To create and schedule the posts |

Social Hub asks only for the permissions needed to post:

- **TikTok:** `user.info.basic` and `video.publish`
- **Meta:** `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` and `business_management`

It doesn't read followers' profiles, messages, comments or contact lists, and it doesn't collect information from the people who see the posts.

## 3. How it's used

This information is used only to connect the operator's accounts and to publish and schedule the operator's posts. It isn't used for advertising, profiling or any other purpose.

## 4. Sharing

Social Hub doesn't sell, rent or share information. It sends information only to the platform a post is published to. Social Hub has no analytics, tracking or "phone home" features: nothing is sent to the maintainers or to anyone else.

To publish to Instagram, Social Hub makes the photo or video available at a hard-to-guess web address on the operator's server, because Instagram downloads it from there.

## 5. Storage and security

- Everything is stored on the operator's own server, not on a third-party service.
- Social Hub's web interface requires a password. It is designed to be opened only from the operator's private network; from the internet, only media files and the login return pages are reachable.
- Access tokens are kept on the server and are never shown in the web interface.
- Connections to TikTok and Meta use encrypted HTTPS.

## 6. How long it's kept

- **Access tokens:** until the account is disconnected, or until the platform expires or revokes them.
- **Posts and media:** until they are deleted from Social Hub.
- **When an account is disconnected:** its tokens and account details are deleted from Social Hub right away.

## 7. Children

Social Hub isn't directed to children and doesn't collect information from them.

## 8. Data deletion

You can remove Social Hub's access, and delete what it stores, in any of these ways.

**Remove access from the platform:**

1. **TikTok:** in the TikTok app, open Settings and privacy → Security → Manage app permissions, choose the app and select Remove access.
2. **Facebook and Instagram:** on Facebook, open Settings and privacy → Settings → Apps and websites (or Business Integrations), choose the app and select Remove.

Once access is removed, the stored tokens stop working and Social Hub can no longer post to that account.

**Delete the stored information:**

- **From Social Hub:** on the Accounts page, click Disconnect. This deletes that account's tokens and details right away.
- **By request:** ask the operator of the Social Hub server that holds your information. Only the operator can see or delete it.

## 9. Changes

This policy may be updated. The effective date at the top shows when it last changed, and this file's history on GitHub shows every change.
