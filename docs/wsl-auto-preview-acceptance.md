# WSL automatic Preview acceptance

This documentation-only PR checks the automatic Preview flow from a new draft PR.

- Use the PR's exact HEAD and its dedicated Cake Preview and Neon Native branch.
- Confirm that PR creation starts the deployment without a manual deploy dispatch.
- Check the deployment receipt and the PR, SHA, Deployment, DB and generation before and after browsing.
- Use WSL Playwright Chromium with development OIDC limited to the selected origin.
- Check desktop/mobile A/B login, home, transactions and settings without business-data writes.
- Initial migration/seed and the possible first personal workspace/OWNER membership insert are within this test's scope.
- Keep the PR open and draft; merging, closing, cleanup and production operations require a separate request.
