// LC_BUILD_VERSION also includes the linker's own "version" field. That is
// not an OS requirement. Legacy LC_VERSION_MIN_MACOSX uses "version" instead.
export function minimumMacOSVersions(loadCommands) {
  return loadCommands.split(/Load command \d+/).flatMap((section) => {
    const field = /cmd LC_BUILD_VERSION\b/.test(section)
      ? /^\s+minos (\d+\.\d+(?:\.\d+)?)\s*$/m
      : /cmd LC_VERSION_MIN_MACOSX\b/.test(section)
        ? /^\s+version (\d+\.\d+(?:\.\d+)?)\s*$/m
        : null;
    const version = field && section.match(field)?.[1];
    return version ? [version] : [];
  });
}
