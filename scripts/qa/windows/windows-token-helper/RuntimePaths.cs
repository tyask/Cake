using System;
using System.IO;
using System.Text.RegularExpressions;

namespace CakeQaHelper
{
    internal static class RuntimePaths
    {
        // Resolve the current Windows profile at launch. No username, SID or
        // repository location is part of the persisted credential format.
        internal static string StoreRoot
        {
            get
            {
                return ResolveStoreRoot(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
            }
        }

        internal static string ResolveStoreRoot(string local)
        {
            if (String.IsNullOrEmpty(local) || !Path.IsPathRooted(local))
                throw new SafeFailure("WINDOWS_PROFILE_UNAVAILABLE");
            string full = Path.GetFullPath(local);
            // A sandbox may redirect this Known Folder to Packages/<package>/AC.
            // Do not search other profiles or silently create a second store.
            if (Regex.IsMatch(full, @"[\\/]Packages[\\/][^\\/]+[\\/]AC(?:[\\/]|$)", RegexOptions.IgnoreCase))
                throw new SafeFailure("WINDOWS_PROFILE_CONTEXT_REJECTED");
            return Path.Combine(full, "CakeQa");
        }
    }
}
