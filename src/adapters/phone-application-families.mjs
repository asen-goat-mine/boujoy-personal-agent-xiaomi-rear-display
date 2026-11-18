// Exact OS settings modules. This maps navigation/read surfaces only and never
// grants messaging, purchases, setting mutations or arbitrary package prefixes.
const SETTINGS_MODULES=Object.freeze(['com.samsung.android.sm_cn','com.samsung.android.lool']);
export function navigationPackages(packageName){return packageName==='com.android.settings'?[packageName,...SETTINGS_MODULES]:[packageName];}
export function navigationPackageAllowed(requested,observed){return navigationPackages(requested).includes(observed);}
