using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Security;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CakeQaHelper
{
    internal static class SelfTests
    {
        private const string Dummy = "vcp_cake_dummy_only_not_a_real_token";

        internal static Dictionary<string, object> Run(string requestedRoot)
        {
            string root = Path.GetFullPath(requestedRoot).TrimEnd(Path.DirectorySeparatorChar);
            string testBase = Path.GetFullPath(BuildInfo.TestBase).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            string approved = Path.GetFullPath(RuntimePaths.StoreRoot).TrimEnd(Path.DirectorySeparatorChar);
            if (!root.StartsWith(testBase, StringComparison.OrdinalIgnoreCase) ||
                String.Equals(root, approved, StringComparison.OrdinalIgnoreCase) ||
                root.StartsWith(approved + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                approved.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
                File.Exists(root) || Directory.Exists(root))
                throw new SafeFailure("SELF_TEST_PATH_REJECTED");
            TokenStore.RejectReparseAncestors(root);
            TokenStore testRoot = new TokenStore(root);
            testRoot.CreateFreshRoot();
            Dictionary<string, object> result = new Dictionary<string, object>();
            result["protocol"] = "cake-token-selftest/v1";
            result["success"] = false;
            result["dummyOnly"] = true;
            result["networkRequests"] = 0;
            result["filesDeleted"] = false;
            foreach (string key in new string[] { "dpapiRoundTrip", "ciphertextHasNoDummy", "ownerOnlyProtectedAcl",
                "duplicateSaveRejectedUnchanged", "tamperedCipherRejected", "unsafeAclRejected",
                "childDummyMatched", "childUnwantedEnvironmentAbsent", "unsafeEnvironmentFiltered",
                "parentTokenPresenceUnchanged", "tamperedChildRejectedBeforeDecrypt", "guiPasswordMasked",
                "guiHasNoShowPasswordControl", "guiHasNoImplicitSave", "guiPreviewSaved", "failedRunnerProofInvalidated",
                "existingFailedProofPreserved", "childResponseSecretsRejected", "sandboxProfileRejected", "normalProfileResolved",
                "validVerifyConfigAccepted" }) result[key] = false;
            bool parentTokenPresentBefore = Environment.GetEnvironmentVariable("VERCEL_TOKEN") != null;
            try
            {
                string fakeLocal = Path.Combine(Path.GetPathRoot(Environment.SystemDirectory), "CakeQaDummyProfile", "Local");
                result["normalProfileResolved"] = RuntimePaths.ResolveStoreRoot(fakeLocal) == Path.Combine(fakeLocal, "CakeQa");
                try { RuntimePaths.ResolveStoreRoot(Path.Combine(fakeLocal, "Packages", "dummy-package", "AC", "Local")); }
                catch (SafeFailure failure) { result["sandboxProfileRejected"] = failure.Code == "WINDOWS_PROFILE_CONTEXT_REJECTED"; }
                TokenStore store = NewDummyStore(Path.Combine(root, "roundtrip-store"));
                byte[] clear = store.UnprotectForChild();
                try { result["dpapiRoundTrip"] = Encoding.UTF8.GetString(clear) == Dummy; }
                finally { Array.Clear(clear, 0, clear.Length); }
                byte[] before = File.ReadAllBytes(store.TokenPath);
                try
                {
                    result["ciphertextHasNoDummy"] = Encoding.UTF8.GetString(before).IndexOf(Dummy, StringComparison.Ordinal) < 0;
                    store.ValidateTokenFile();
                    result["ownerOnlyProtectedAcl"] = OwnerOnly(store);
                    bool duplicateRejected = false;
                    try { SaveDummy(store); }
                    catch (SafeFailure failure) { duplicateRejected = failure.Code == "TOKEN_ALREADY_EXISTS"; }
                    byte[] after = File.ReadAllBytes(store.TokenPath);
                    try { result["duplicateSaveRejectedUnchanged"] = duplicateRejected && BytesEqual(before, after); }
                    finally { Array.Clear(after, 0, after.Length); }
                }
                finally { Array.Clear(before, 0, before.Length); }

                TokenStore tampered = NewDummyStore(Path.Combine(root, "tampered-cipher-store"));
                Dictionary<string, object> record = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(tampered.TokenPath, Encoding.UTF8));
                byte[] cipher = Convert.FromBase64String((string)record["protectedToken"]);
                try
                {
                    cipher[cipher.Length / 2] ^= 1;
                    record["protectedToken"] = Convert.ToBase64String(cipher);
                    File.WriteAllText(tampered.TokenPath, new JavaScriptSerializer().Serialize(record), new UTF8Encoding(false));
                }
                finally { Array.Clear(cipher, 0, cipher.Length); record.Clear(); }
                try
                {
                    byte[] rejected = tampered.UnprotectForChild();
                    Array.Clear(rejected, 0, rejected.Length);
                }
                catch (SafeFailure failure) { result["tamperedCipherRejected"] = failure.Code == "TOKEN_DECRYPT_FAILED"; }

                TokenStore unsafeStore = new TokenStore(Path.Combine(root, "unsafe-acl-store"));
                unsafeStore.CreateFreshRoot();
                DirectorySecurity unsafeAcl = Directory.GetAccessControl(unsafeStore.RootPath);
                unsafeAcl.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(WellKnownSidType.BuiltinUsersSid, null),
                    FileSystemRights.ReadAndExecute, AccessControlType.Allow));
                Directory.SetAccessControl(unsafeStore.RootPath, unsafeAcl);
                try { unsafeStore.ValidateNewStore(); }
                catch (SafeFailure failure) { result["unsafeAclRejected"] = failure.Code == "STORE_ACL_REJECTED"; }

                Dictionary<string, string> syntheticEnvironment = TokenRunner.SafeParentEnvironment();
                foreach (string key in new string[] { "DATABASE_URL", "DIRECT_URL", "NEXTAUTH_SECRET", "AUTH_SECRET",
                    "VERCEL_OIDC_TOKEN", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN",
                    "DEBUG", "PWDEBUG", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "VERCEL_TOKEN" })
                    syntheticEnvironment[key] = "dummy-only-do-not-inherit";
                Dictionary<string, string> filtered = TokenRunner.FilterEnvironment(syntheticEnvironment);
                bool filteredSafe = true;
                foreach (string key in new string[] { "DATABASE_URL", "DIRECT_URL", "NEXTAUTH_SECRET", "AUTH_SECRET",
                    "VERCEL_OIDC_TOKEN", "OPENAI_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN",
                    "DEBUG", "PWDEBUG", "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED", "VERCEL_TOKEN" })
                    if (filtered.ContainsKey(key)) filteredSafe = false;
                result["unsafeEnvironmentFiltered"] = filteredSafe;
                filtered.Clear();
                Dictionary<string, object> child = TokenRunner.RunDummy(store, syntheticEnvironment);
                result["childDummyMatched"] = (bool)child["success"] && (bool)child["dummyMatched"];
                result["childUnwantedEnvironmentAbsent"] = (bool)child["unwantedEnvironmentAbsent"] && (int)child["networkRequests"] == 0;
                syntheticEnvironment.Clear();

                TokenStore noToken = new TokenStore(Path.Combine(root, "no-token-store"));
                noToken.CreateFreshRoot();
                string tamperDirectory = Path.Combine(root, "tampered-child");
                TokenStore tamperFiles = new TokenStore(tamperDirectory);
                tamperFiles.CreateFreshRoot();
                string tamperedScript = Path.Combine(tamperDirectory, "dummy-child.mjs");
                File.WriteAllText(tamperedScript, "// Deliberately invalid dummy hash. Never execute.\n", new UTF8Encoding(false));
                try { TokenRunner.RejectTamperedDummyBeforeDecrypt(noToken, tamperedScript); }
                catch (SafeFailure failure) { result["tamperedChildRejectedBeforeDecrypt"] = failure.Code == "CHILD_INTEGRITY_REJECTED"; }

                string proofTarget = Path.Combine(root, "dummy-proof-target");
                result["validVerifyConfigAccepted"] = TokenRunner.AcceptsValidDummyVerifyConfig(proofTarget);
                Directory.CreateDirectory(Path.Combine(proofTarget, ".cake"));
                string proofPath = Path.Combine(proofTarget, ".cake", "verification.json");
                File.WriteAllText(proofPath, "{\"protocol\":\"cake-preview-browser/v1\",\"success\":true}\n", new UTF8Encoding(false));
                TokenRunner.InvalidateDummyProof(proofTarget);
                Dictionary<string, object> failedProof = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(proofPath, Encoding.UTF8));
                result["failedRunnerProofInvalidated"] = failedProof["success"] is bool && !(bool)failedProof["success"] &&
                    (string)failedProof["runnerFailureCode"] == "WINDOWS_QA_RUNNER_NOT_COMPLETED";
                byte[] failedBefore = File.ReadAllBytes(proofPath);
                TokenRunner.InvalidateDummyProof(proofTarget);
                byte[] failedAfter = File.ReadAllBytes(proofPath);
                result["existingFailedProofPreserved"] = BytesEqual(failedBefore, failedAfter);
                result["childResponseSecretsRejected"] = TokenRunner.RejectsUnexpectedChildFields();

                TokenStore guiStore = new TokenStore(Path.Combine(root, "gui-empty-store"));
                guiStore.CreateFreshRoot();
                Application.EnableVisualStyles();
                using (TokenInputForm form = new TokenInputForm(guiStore))
                {
                    FieldInfo tokenField = typeof(TokenInputForm).GetField("tokenBox", BindingFlags.NonPublic | BindingFlags.Instance);
                    TextBox box = tokenField == null ? null : tokenField.GetValue(form) as TextBox;
                    result["guiPasswordMasked"] = box != null && box.UseSystemPasswordChar;
                    result["guiHasNoShowPasswordControl"] = CountCheckBoxes(form) == 1;
                    result["guiHasNoImplicitSave"] = form.AcceptButton == null;
                    // Render only this empty, dummy-store form offscreen. Showing
                    // creates the native child handles needed by DrawToBitmap.
                    form.ShowInTaskbar = false;
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new Point(-32000, -32000);
                    form.Show();
                    Application.DoEvents();
                    form.PerformLayout();
                    form.Update();
                    using (Bitmap preview = new Bitmap(form.Width, form.Height))
                    {
                        form.DrawToBitmap(preview, new Rectangle(0, 0, form.Width, form.Height));
                        preview.Save(Path.Combine(root, "input-preview.png"), ImageFormat.Png);
                    }
                    form.Hide();
                    result["guiPreviewSaved"] = File.Exists(Path.Combine(root, "input-preview.png")) && !guiStore.Exists;
                }
            }
            catch (SafeFailure) { result["code"] = "SELF_TEST_FAILED"; }
            catch { result["code"] = "SELF_TEST_FAILED"; }
            finally
            {
                result["parentTokenPresenceUnchanged"] = parentTokenPresentBefore == (Environment.GetEnvironmentVariable("VERCEL_TOKEN") != null);
            }
            bool all = true;
            foreach (KeyValuePair<string, object> item in result)
                if (item.Value is bool && item.Key != "success" && item.Key != "filesDeleted" && !(bool)item.Value) all = false;
            result["success"] = all && !result.ContainsKey("code");
            if (!result.ContainsKey("code")) result["code"] = (bool)result["success"] ? "OK" : "SELF_TEST_FAILED";
            Program.WritePublicFile(testRoot, "self-test-result.json", result);
            return result;
        }

        private static TokenStore NewDummyStore(string path)
        {
            TokenStore store = new TokenStore(path);
            store.CreateFreshRoot();
            SaveDummy(store);
            return store;
        }

        private static void SaveDummy(TokenStore store)
        {
            using (SecureString value = new SecureString())
            {
                foreach (char character in Dummy) value.AppendChar(character);
                value.MakeReadOnly();
                store.Save(value);
            }
        }

        private static bool BytesEqual(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }

        private static bool OwnerOnly(TokenStore store)
        {
            DirectorySecurity root = Directory.GetAccessControl(store.RootPath);
            FileSecurity file = File.GetAccessControl(store.TokenPath);
            return root.AreAccessRulesProtected && file.AreAccessRulesProtected &&
                ((SecurityIdentifier)root.GetOwner(typeof(SecurityIdentifier))).Value == store.UserSid &&
                ((SecurityIdentifier)file.GetOwner(typeof(SecurityIdentifier))).Value == store.UserSid &&
                root.GetAccessRules(true, true, typeof(SecurityIdentifier)).Count == 1 &&
                file.GetAccessRules(true, true, typeof(SecurityIdentifier)).Count == 1;
        }

        private static int CountCheckBoxes(Control control)
        {
            int count = control is CheckBox ? 1 : 0;
            foreach (Control child in control.Controls) count += CountCheckBoxes(child);
            return count;
        }
    }
}
