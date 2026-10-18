import { createRoot } from "react-dom/client";
import { LoginScreen } from "../../components/login-screen";
import { homeNavigation } from "../../lib/home-navigation";

declare global {
  interface Window {
    signInRequests: { provider: string; redirectTo: string; testUserKey?: string }[];
  }
}

window.signInRequests = [];
const params = new URLSearchParams(location.search);
const { redirectTo } = homeNavigation(Object.fromEntries(params));
createRoot(document.getElementById("root")!).render(<LoginScreen testAuth={params.has("testAuth")} redirectTo={redirectTo} />);
