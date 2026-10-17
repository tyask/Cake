using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CakeQaHelper
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            try
            {
                if (args.Length == 2 && (args[0] == "--self-test" || args[0] == "--dummy"))
                    return Print(SelfTests.Run(args[1]));
                if (args.Length != 1) throw new SafeFailure("ARGUMENTS_REJECTED");
                string mode = args[0];
                if (mode != "--input" && mode != "--status" && mode != "--preflight" && mode != "--verify")
                    throw new SafeFailure("ARGUMENTS_REJECTED");

                TokenStore store = new TokenStore(RuntimePaths.StoreRoot);
                if (mode == "--input")
                {
                    // No existing record is read or replaced by the save-only GUI.
                    if (!Directory.Exists(store.RootPath)) store.CreateFreshRoot();
                    store.ValidateNewStore();
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    using (TokenInputForm form = new TokenInputForm(store)) Application.Run(form);
                    bool saved = store.Exists;
                    if (saved) store.ValidateTokenFile();
                    return Print(new Dictionary<string, object> {
                        { "protocol", "cake-token-input/v1" }, { "success", true }, { "tokenSaved", saved },
                        { "tokenContentsRead", false }, { "networkRequests", 0 }
                    });
                }
                if (mode == "--status")
                {
                    bool directoryExists = Directory.Exists(store.RootPath);
                    bool exists = store.Exists;
                    if (directoryExists) store.ValidateRoot();
                    else if (File.Exists(store.RootPath)) throw new SafeFailure("STORE_ACL_REJECTED");
                    if (exists) store.ValidateTokenFile();
                    return Print(new Dictionary<string, object> {
                        { "protocol", "cake-token-status/v1" }, { "success", true }, { "tokenSaved", exists },
                        { "aclValidated", directoryExists }, { "tokenContentsRead", false }, { "networkRequests", 0 }
                    });
                }
                return Print(TokenRunner.RunTrusted(store, mode.Substring(2)));
            }
            catch (SafeFailure failure) { return PrintError(TokenRunner.IsPublicFailureCode(failure.Code) ? failure.Code : "OPERATION_FAILED"); }
            catch { return PrintError("OPERATION_FAILED"); }
        }

        private static int PrintError(string code)
        {
            return Print(new Dictionary<string, object> {
                { "protocol", "cake-token-helper-error/v1" }, { "success", false }, { "code", code }
            });
        }

        private static int Print(Dictionary<string, object> result)
        {
            // Only allowlisted dictionaries reach stdout. Never write exceptions,
            // credential records, child stdout/stderr or user-entered text.
            Console.WriteLine(new JavaScriptSerializer().Serialize(result));
            return (bool)result["success"] ? 0 : 1;
        }

        internal static void WritePublicFile(TokenStore store, string name, Dictionary<string, object> result)
        {
            store.ValidateRoot();
            if (Path.GetFileName(name) != name) throw new SafeFailure("METADATA_WRITE_FAILED");
            byte[] bytes = new UTF8Encoding(false).GetBytes(new JavaScriptSerializer().Serialize(result));
            try
            {
                using (FileStream stream = new FileStream(Path.Combine(store.RootPath, name), FileMode.CreateNew,
                    System.Security.AccessControl.FileSystemRights.Write, FileShare.None, 4096, FileOptions.None,
                    TokenStore.FileAcl(new SecurityIdentifier(store.UserSid))))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }
            }
            catch { throw new SafeFailure("METADATA_WRITE_FAILED"); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }
    }
}
