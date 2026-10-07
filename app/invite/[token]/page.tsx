import { InviteCard } from "@/components/invite-card";
import { isTestAuthEnabled } from "@/lib/auth-mode";
import { getCurrentUser } from "@/lib/current-user";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getCurrentUser();
  return <InviteCard token={token} signedIn={Boolean(user)} testAuth={isTestAuthEnabled()} />;
}
