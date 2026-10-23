import { InviteCard } from "@/components/invite-card";
import { isTestAuthEnabled } from "@/lib/server/auth/auth-mode";
import { getCurrentUser } from "@/lib/server/auth/current-user";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getCurrentUser();
  return <InviteCard token={token} signedIn={Boolean(user)} testAuth={isTestAuthEnabled()} />;
}
