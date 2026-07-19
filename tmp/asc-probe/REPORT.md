# App Store Connect probe report

Generated: 2026-04-23T21:08:48.771Z
Output dir: H:\BigBlueBam\tmp\asc-probe
Bundle id: com.bigblueceiling.aiviseme

## Summary

| Step | Status | Note |
|------|--------|------|
| 01 Mint ES256 JWT | OK |  |
| 02 Resolve app by bundleId | OK | app.id=6749811142 name=Frndo |
| 03 List recent crash submissions (with includes) | OK | 10 crashes; included types: {"builds":6,"betaTesters":5} |
| 04 List recent screenshot submissions (with includes) | OK | 9 screenshots; included types: {"builds":5,"betaTesters":4} |
| 05 Fetch one crash submission detail | OK |  |
| 06 Download crash log (capture redirect / content-type) | SKIP | no crash in the 10-crash sample has crashLog.data populated; likely all user-reported feedback rather than OS-captured crashes |
| 07 Fetch one screenshot submission detail and download an image | OK | 7 url-bearing fields found; 419883 bytes downloaded |
| 08 Fetch one beta tester (PII surface check) | OK |  |
| 09 Pagination probe (limit=2 + walk next once) | OK | page1 returned 2, page2 returned 2 |
| 10 Webhooks read-only probe (per-app) | OK | /v1/apps/6749811142/webhooks returned 0 |

## 01. Mint ES256 JWT

Status: **OK**
Raw response: `tmp\asc-probe\01-jwt-decoded.json`
Observations:
```json
{
  "issuer": "69a6de71-4bb3-47e3-e053-5b8c7c11a4d1",
  "audience": "appstoreconnect-v1",
  "ttlSeconds": 1140,
  "jwtCharLength": 293
}
```

## 02. Resolve app by bundleId

Status: **OK**
Note: app.id=6749811142 name=Frndo
Raw response: `tmp\asc-probe\02-apps.json`
Elapsed: 301ms
Rate-limit headers:
```
x-rate-limit: user-hour-lim:3600;user-hour-rem:3582;
```
Observations:
```json
{
  "app": {
    "type": "apps",
    "id": "6749811142",
    "attributeKeys": [
      "accessibilityUrl",
      "name",
      "bundleId",
      "sku",
      "primaryLocale",
      "isOrEverWasMadeForKids",
      "subscriptionStatusUrl",
      "subscriptionStatusUrlVersion",
      "subscriptionStatusUrlForSandbox",
      "subscriptionStatusUrlVersionForSandbox",
      "contentRightsDeclaration",
      "streamlinedPurchasingEnabled"
    ],
    "relationshipKeys": [
      "accessibilityDeclarations",
      "ciProduct",
      "betaTesters",
      "betaGroups",
      "appStoreVersions",
      "appTags",
      "preReleaseVersions",
      "betaAppLocalizations",
      "builds",
      "betaLicenseAgreement",
      "betaAppReviewDetail",
      "appInfos",
      "appClips",
      "appPricePoints",
      "endUserLicenseAgreement",
      "appPriceSchedule",
      "appAvailabilityV2",
      "inAppPurchases",
      "subscriptionGroups",
      "gameCenterEnabledVersions",
      "perfPowerMetrics",
      "appCustomProductPages",
      "inAppPurchasesV2",
      "promotedPurchases",
      "appEvents",
      "reviewSubmissions",
      "subscriptionGracePeriod",
      "customerReviews",
      "customerReviewSummarizations",
      "gameCenterDetail",
      "appStoreVersionExperimentsV2",
      "alternativeDistributionKey",
      "analyticsReportRequests",
      "marketplaceSearchDetail",
      "buildUploads",
      "backgroundAssets",
      "betaFeedbackScreenshotSubmissions",
      "betaFeedbackCrashSubmissions",
      "searchKeywords",
      "webhooks",
      "androidToIosAppMappingDetails"
    ],
    "sampleAttributes": {
      "accessibilityUrl": null,
      "name": "Frndo",
      "bundleId": "com.bigblueceiling.aiviseme",
      "sku": "AIVisemeFrndo",
      "primaryLocale": "en-US",
      "isOrEverWasMadeForKids": false,
      "subscriptionStatusUrl": null,
      "subscriptionStatusUrlVersion": null,
      "subscriptionStatusUrlForSandbox": null,
      "subscriptionStatusUrlVersionForSandbox": null,
      "contentRightsDeclaration": null,
      "streamlinedPurchasingEnabled": true
    },
    "relationshipPreview": {
      "accessibilityDeclarations": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "ciProduct": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "betaTesters": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self"
        ]
      },
      "betaGroups": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appStoreVersions": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appTags": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "preReleaseVersions": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "betaAppLocalizations": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "builds": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "betaLicenseAgreement": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "betaAppReviewDetail": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appInfos": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appClips": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appPricePoints": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "endUserLicenseAgreement": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appPriceSchedule": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appAvailabilityV2": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "inAppPurchases": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "subscriptionGroups": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "gameCenterEnabledVersions": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "perfPowerMetrics": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "related"
        ]
      },
      "appCustomProductPages": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "inAppPurchasesV2": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "promotedPurchases": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appEvents": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "reviewSubmissions": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "subscriptionGracePeriod": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "customerReviews": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "customerReviewSummarizations": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "related"
        ]
      },
      "gameCenterDetail": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "appStoreVersionExperimentsV2": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "alternativeDistributionKey": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "analyticsReportRequests": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "marketplaceSearchDetail": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "buildUploads": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "backgroundAssets": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "betaFeedbackScreenshotSubmissions": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "betaFeedbackCrashSubmissions": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "searchKeywords": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "webhooks": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "androidToIosAppMappingDetails": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      }
    }
  },
  "totalMatches": 1
}
```

## 03. List recent crash submissions (with includes)

Status: **OK**
Note: 10 crashes; included types: {"builds":6,"betaTesters":5}
Raw response: `tmp\asc-probe\03-crashes-list.json`
Elapsed: 339ms
Rate-limit headers:
```
x-rate-limit: user-hour-lim:3600;user-hour-rem:3581;
```
Observations:
```json
{
  "count": 10,
  "sampleResource": {
    "type": "betaFeedbackCrashSubmissions",
    "id": "AJFK8ildSoJV5EYsCpHXqNA",
    "attributeKeys": [
      "screenWidthInPoints",
      "appPlatform",
      "buildBundleId",
      "timeZone",
      "devicePlatform",
      "deviceFamily",
      "locale",
      "diskBytesTotal",
      "connectionType",
      "diskBytesAvailable",
      "createdDate",
      "pairedAppleWatch",
      "osVersion",
      "comment",
      "deviceModel",
      "batteryPercentage",
      "appUptimeInMilliseconds",
      "screenHeightInPoints",
      "email",
      "architecture"
    ],
    "relationshipKeys": [
      "crashLog",
      "tester",
      "build"
    ],
    "sampleAttributes": {
      "screenWidthInPoints": 428,
      "appPlatform": "IOS",
      "buildBundleId": "com.bigblueceiling.aiviseme",
      "timeZone": "America/Los_Angeles",
      "devicePlatform": "IOS",
      "deviceFamily": "IPHONE",
      "locale": "en-US",
      "diskBytesTotal": 1023877271552,
      "connectionType": "WIFI",
      "diskBytesAvailable": 776977821696,
      "createdDate": "2026-04-22T20:51:31.373Z",
      "pairedAppleWatch": null,
      "osVersion": "26.3.1",
      "comment": "Difficulty getting started second attempt I received the crash message. The first attempt I just got a black screen with waiting which I can send you a copy of if you want it. I did take a screenshot ... (271 chars total)",
      "deviceModel": "iPhone14_3",
      "batteryPercentage": 75,
      "appUptimeInMilliseconds": 32000,
      "screenHeightInPoints": 926,
      "email": "Eastbluffvista@gmail.com",
      "architecture": "arm64e"
    },
    "relationshipPreview": {
      "crashLog": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "tester": {
        "hasData": true,
        "dataShape": "object",
        "links": []
      },
      "build": {
        "hasData": true,
        "dataShape": "object",
        "links": []
      }
    }
  },
  "includedTesterSample": {
    "type": "betaTesters",
    "id": "8d056895-40ba-4c32-a302-9fdb01cc08ac",
    "attributes": {
      "lastName": "Mooney",
      "firstName": "Ted",
      "inviteType": "EMAIL",
      "state": null,
      "email": "ted@travelwincorp.com"
    },
    "relationships": {
      "betaGroups": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/relationships/betaGroups",
          "related": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/betaGroups"
        }
      },
      "builds": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/relationships/builds",
          "related": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/builds"
        }
      },
      "apps": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/relationships/apps",
          "related": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/apps"
        }
      }
    },
    "links": {
      "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac"
    }
  },
  "includedBuildSample": {
    "type": "builds",
    "id": "6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f",
    "attributes": {
      "minOsVersion": "13.0",
      "processingState": "VALID",
      "buildAudienceType": "APP_STORE_ELIGIBLE",
      "expired": false,
      "lsMinimumSystemVersion": null,
      "iconAssetToken": {
        "templateUrl": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/33/1f/75/331f7592-6180-641e-0ca1-677e0c259bc3/AppIcon-0-0-2x_U007epad-0-6-0-85-220.png/{w}x{h}bb.{f}",
        "width": 167,
        "height": 167
      },
      "usesNonExemptEncryption": false,
      "uploadedDate": "2026-04-19T10:52:36-07:00",
      "version": "260419172",
      "computedMinVisionOsVersion": "1.0",
      "computedMinMacOsVersion": "11.0",
      "expirationDate": "2026-07-18T10:52:36-07:00"
    },
    "relationships": {
      "individualTesters": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/individualTesters",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/individualTesters"
        }
      },
      "betaGroups": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/betaGroups"
        }
      },
      "app": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/app",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/app"
        }
      },
      "preReleaseVersion": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/preReleaseVersion",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/preReleaseVersion"
        }
      },
      "betaAppReviewSubmission": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/betaAppReviewSubmission",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/betaAppReviewSubmission"
        }
      },
      "appStoreVersion": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/appStoreVersion",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/appStoreVersion"
        }
      },
      "perfPowerMetrics": {
        "links": {
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/perfPowerMetrics"
        }
      },
      "appEncryptionDeclaration": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/appEncryptionDeclaration",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/appEncryptionDeclaration"
        }
      },
      "buildBetaDetail": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/buildBetaDetail",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/buildBetaDetail"
        }
      },
      "icons": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/icons",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/icons"
        }
      },
      "diagnosticSignatures": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/diagnosticSignatures",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/diagnosticSignatures"
        }
      },
      "betaBuildLocalizations": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/betaBuildLocalizations",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/betaBuildLocalizations"
        }
      }
    },
    "links": {
      "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f"
    }
  },
  "pagination": {
    "self": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackCrashSubmissions?include=build%2Ctester&sort=-createdDate&limit=10"
  },
  "meta": {
    "paging": {
      "total": 10,
      "limit": 10
    }
  }
}
```

## 04. List recent screenshot submissions (with includes)

Status: **OK**
Note: 9 screenshots; included types: {"builds":5,"betaTesters":4}
Raw response: `tmp\asc-probe\04-screenshots-list.json`
Elapsed: 586ms
Rate-limit headers:
```
x-rate-limit: user-hour-lim:3600;user-hour-rem:3580;
```
Observations:
```json
{
  "count": 9,
  "sampleResource": {
    "type": "betaFeedbackScreenshotSubmissions",
    "id": "AHGWU2dsr0EJyIGC8h4iu_Y",
    "attributeKeys": [
      "screenWidthInPoints",
      "appPlatform",
      "buildBundleId",
      "timeZone",
      "devicePlatform",
      "deviceFamily",
      "locale",
      "diskBytesTotal",
      "connectionType",
      "screenshots",
      "diskBytesAvailable",
      "createdDate",
      "pairedAppleWatch",
      "osVersion",
      "comment",
      "deviceModel",
      "batteryPercentage",
      "appUptimeInMilliseconds",
      "screenHeightInPoints",
      "email",
      "architecture"
    ],
    "relationshipKeys": [
      "tester",
      "build"
    ],
    "sampleAttributes": {
      "screenWidthInPoints": 440,
      "appPlatform": "IOS",
      "buildBundleId": "com.bigblueceiling.aiviseme",
      "timeZone": "America/New_York",
      "devicePlatform": "IOS",
      "deviceFamily": "IPHONE",
      "locale": "en-US",
      "diskBytesTotal": 511417995264,
      "connectionType": "WIFI",
      "screenshots": "array(7) first={\"url\":\"https://tf-feedback.itunes.apple.com/eimg/JdI/Jeg/CDY/DMw/IDA/eqTnJFiBWl8/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=US2At0Rhk%2FOiWEYOa1FCA",
      "diskBytesAvailable": 141163696128,
      "createdDate": "2026-04-23T18:43:07.454Z",
      "pairedAppleWatch": null,
      "osVersion": "26.3.1",
      "comment": "Not able to test. App is still resolving after having hit the button to test after not gotten through to the app via the direct link because that was asking for a code.",
      "deviceModel": "iPhone17_2",
      "batteryPercentage": 85,
      "appUptimeInMilliseconds": 500000,
      "screenHeightInPoints": 956,
      "email": null,
      "architecture": "arm64e"
    },
    "relationshipPreview": {
      "tester": {
        "hasData": true,
        "dataShape": "object",
        "links": []
      },
      "build": {
        "hasData": true,
        "dataShape": "object",
        "links": []
      }
    }
  },
  "includedTesterSample": {
    "type": "betaTesters",
    "id": "8d056895-40ba-4c32-a302-9fdb01cc08ac",
    "attributes": {
      "lastName": "Mooney",
      "firstName": "Ted",
      "inviteType": "EMAIL",
      "state": null,
      "email": "ted@travelwincorp.com"
    },
    "relationships": {
      "betaGroups": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/relationships/betaGroups",
          "related": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/betaGroups"
        }
      },
      "builds": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/relationships/builds",
          "related": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/builds"
        }
      },
      "apps": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/relationships/apps",
          "related": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac/apps"
        }
      }
    },
    "links": {
      "self": "https://api.appstoreconnect.apple.com/v1/betaTesters/8d056895-40ba-4c32-a302-9fdb01cc08ac"
    }
  },
  "includedBuildSample": {
    "type": "builds",
    "id": "6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f",
    "attributes": {
      "minOsVersion": "13.0",
      "processingState": "VALID",
      "buildAudienceType": "APP_STORE_ELIGIBLE",
      "expired": false,
      "lsMinimumSystemVersion": null,
      "iconAssetToken": {
        "templateUrl": "https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/33/1f/75/331f7592-6180-641e-0ca1-677e0c259bc3/AppIcon-0-0-2x_U007epad-0-6-0-85-220.png/{w}x{h}bb.{f}",
        "width": 167,
        "height": 167
      },
      "usesNonExemptEncryption": false,
      "uploadedDate": "2026-04-19T10:52:36-07:00",
      "version": "260419172",
      "computedMinVisionOsVersion": "1.0",
      "computedMinMacOsVersion": "11.0",
      "expirationDate": "2026-07-18T10:52:36-07:00"
    },
    "relationships": {
      "individualTesters": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/individualTesters",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/individualTesters"
        }
      },
      "betaGroups": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/betaGroups"
        }
      },
      "app": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/app",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/app"
        }
      },
      "preReleaseVersion": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/preReleaseVersion",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/preReleaseVersion"
        }
      },
      "betaAppReviewSubmission": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/betaAppReviewSubmission",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/betaAppReviewSubmission"
        }
      },
      "appStoreVersion": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/appStoreVersion",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/appStoreVersion"
        }
      },
      "perfPowerMetrics": {
        "links": {
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/perfPowerMetrics"
        }
      },
      "appEncryptionDeclaration": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/appEncryptionDeclaration",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/appEncryptionDeclaration"
        }
      },
      "buildBetaDetail": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/buildBetaDetail",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/buildBetaDetail"
        }
      },
      "icons": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/icons",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/icons"
        }
      },
      "diagnosticSignatures": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/diagnosticSignatures",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/diagnosticSignatures"
        }
      },
      "betaBuildLocalizations": {
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/relationships/betaBuildLocalizations",
          "related": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f/betaBuildLocalizations"
        }
      }
    },
    "links": {
      "self": "https://api.appstoreconnect.apple.com/v1/builds/6d1cbc4c-1fa8-4666-9c01-3d4df9fdbc6f"
    }
  },
  "pagination": {
    "self": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackScreenshotSubmissions?include=build%2Ctester&sort=-createdDate&limit=10"
  },
  "meta": {
    "paging": {
      "total": 9,
      "limit": 10
    }
  }
}
```

## 05. Fetch one crash submission detail

Status: **OK**
Raw response: `tmp\asc-probe\05-crash-detail.json`
Elapsed: 342ms
Rate-limit headers:
```
x-rate-limit: user-hour-lim:3600;user-hour-rem:3579;
```
Observations:
```json
{
  "resource": {
    "type": "betaFeedbackCrashSubmissions",
    "id": "AJFK8ildSoJV5EYsCpHXqNA",
    "attributeKeys": [
      "createdDate",
      "comment",
      "email",
      "deviceModel",
      "osVersion",
      "locale",
      "timeZone",
      "architecture",
      "connectionType",
      "pairedAppleWatch",
      "appUptimeInMilliseconds",
      "diskBytesAvailable",
      "diskBytesTotal",
      "batteryPercentage",
      "screenWidthInPoints",
      "screenHeightInPoints",
      "appPlatform",
      "devicePlatform",
      "deviceFamily",
      "buildBundleId"
    ],
    "relationshipKeys": [
      "crashLog"
    ],
    "sampleAttributes": {
      "createdDate": "2026-04-22T20:51:31.373Z",
      "comment": "Difficulty getting started second attempt I received the crash message. The first attempt I just got a black screen with waiting which I can send you a copy of if you want it. I did take a screenshot ... (271 chars total)",
      "email": "Eastbluffvista@gmail.com",
      "deviceModel": "iPhone14_3",
      "osVersion": "26.3.1",
      "locale": "en-US",
      "timeZone": "America/Los_Angeles",
      "architecture": "arm64e",
      "connectionType": "WIFI",
      "pairedAppleWatch": null,
      "appUptimeInMilliseconds": 32000,
      "diskBytesAvailable": 776977821696,
      "diskBytesTotal": 1023877271552,
      "batteryPercentage": 75,
      "screenWidthInPoints": 428,
      "screenHeightInPoints": 926,
      "appPlatform": "IOS",
      "devicePlatform": "IOS",
      "deviceFamily": "IPHONE",
      "buildBundleId": "com.bigblueceiling.aiviseme"
    },
    "relationshipPreview": {
      "crashLog": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      }
    }
  }
}
```

## 06. Download crash log (capture redirect / content-type)

Status: **SKIP**
Note: no crash in the 10-crash sample has crashLog.data populated; likely all user-reported feedback rather than OS-captured crashes

## 07. Fetch one screenshot submission detail and download an image

Status: **OK**
Note: 7 url-bearing fields found; 419883 bytes downloaded
Raw response: `tmp\asc-probe\07-screenshot-detail.json`
Observations:
```json
{
  "resource": {
    "type": "betaFeedbackScreenshotSubmissions",
    "id": "AHGWU2dsr0EJyIGC8h4iu_Y",
    "attributeKeys": [
      "createdDate",
      "comment",
      "email",
      "deviceModel",
      "osVersion",
      "locale",
      "timeZone",
      "architecture",
      "connectionType",
      "pairedAppleWatch",
      "appUptimeInMilliseconds",
      "diskBytesAvailable",
      "diskBytesTotal",
      "batteryPercentage",
      "screenWidthInPoints",
      "screenHeightInPoints",
      "appPlatform",
      "devicePlatform",
      "deviceFamily",
      "buildBundleId",
      "screenshots"
    ],
    "relationshipKeys": [],
    "sampleAttributes": {
      "createdDate": "2026-04-23T18:43:07.454Z",
      "comment": "Not able to test. App is still resolving after having hit the button to test after not gotten through to the app via the direct link because that was asking for a code.",
      "email": null,
      "deviceModel": "iPhone17_2",
      "osVersion": "26.3.1",
      "locale": "en-US",
      "timeZone": "America/New_York",
      "architecture": "arm64e",
      "connectionType": "WIFI",
      "pairedAppleWatch": null,
      "appUptimeInMilliseconds": 500000,
      "diskBytesAvailable": 141163696128,
      "diskBytesTotal": 511417995264,
      "batteryPercentage": 85,
      "screenWidthInPoints": 440,
      "screenHeightInPoints": 956,
      "appPlatform": "IOS",
      "devicePlatform": "IOS",
      "deviceFamily": "IPHONE",
      "buildBundleId": "com.bigblueceiling.aiviseme",
      "screenshots": "array(7) first={\"url\":\"https://tf-feedback.itunes.apple.com/eimg/JdI/Jeg/CDY/DMw/IDA/eqTnJFiBWl8/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=US2At0Rhk%2FOiWEYOa1FCA"
    },
    "relationshipPreview": {}
  },
  "urlBearingKeys": [
    {
      "path": "screenshots[0].url",
      "url": "https://tf-feedback.itunes.apple.com/eimg/JdI/Jeg/CDY/DMw/IDA/eqTnJFiBWl8/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=US2At0Rhk%2FOiWEYOa1FCAyxcnVE%3D&p_sig=k43BNHSklJw1FSB2w9_WY39-k1c"
    },
    {
      "path": "screenshots[1].url",
      "url": "https://tf-feedback.itunes.apple.com/eimg/FJA/IaE/Fgk/Cqk/GXE/wuXyXIjodrY/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=yYJCUcB3%2BVnmnlmIfUZTBbo8CtQ%3D&p_sig=A8Svz3BIM6nDe4hPu9YfLKZMhQU"
    },
    {
      "path": "screenshots[2].url",
      "url": "https://tf-feedback.itunes.apple.com/eimg/Ebg/ITY/JdE/I1s/GqY/Booh6a_4zTQ/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=9%2FPJ%2FIbX1Aj01q96LEbo4Bc4Z0Q%3D&p_sig=ol-ZhMHIrm-wGtkTu184GzjpY3k"
    },
    {
      "path": "screenshots[3].url",
      "url": "https://tf-feedback.itunes.apple.com/eimg/Dcs/DaI/DCk/AcM/IzA/KprpvePuqs8/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=DnZZEtjvdTzYvVmT84Zv0%2FTmreU%3D&p_sig=ZwDbwNhMJqfy2RSwXdg9miV14Lw"
    },
    {
      "path": "screenshots[4].url",
      "url": "https://tf-feedback.itunes.apple.com/eimg/HoA/AgQ/D7U/Gso/FBU/0LJyi5sa1-k/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=fgp65AnMYPw55JOroHTEtAkmeAc%3D&p_sig=sXYqZWdfgEZ7FcnzK9ovoGzH9zM"
    },
    {
      "path": "screenshots[5].url",
      "url": "https://tf-feedback.itunes.apple.com/eimg/HvU/Cx8/CWw/HyQ/Hlk/iuIGB0-iwW4/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=muc8IcXbSk4nPgR0SaxWf7vqarw%3D&p_sig=4PNvxyqm6rU110lpjcataFcAtOs"
    },
    {
      "path": "screenshots[6].url",
      "url": "https://tf-feedback.itunes.apple.com/eimg/IM8/Cbc/ISg/EAc/HcY/qLApiLSpxrs/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=3n257xw2Eln6wVIxxcC1kLmutcA%3D&p_sig=sHNvnTtXnSiPepAs68JcwKrSEGA"
    }
  ],
  "imageDownload": {
    "url": "https://tf-feedback.itunes.apple.com/eimg/JdI/Jeg/CDY/DMw/IDA/eqTnJFiBWl8/original.jpg?i_for=6749811142&AWSAccessKeyId=MKIA9C0TVRX1ZL0VZ1YK&Expires=1777334400&Signature=US2At0Rhk%2FOiWEYOa1FCAyxcnVE%3D&p_sig=k43BNHSklJw1FSB2w9_WY39-k1c",
    "status": 200,
    "contentType": "image/jpeg",
    "contentLength": 419883
  },
  "imageFile": "H:\\BigBlueBam\\tmp\\asc-probe\\07-screenshot-image.jpg"
}
```

## 08. Fetch one beta tester (PII surface check)

Status: **OK**
Raw response: `tmp\asc-probe\08-tester-detail.json`
Elapsed: 93ms
Rate-limit headers:
```
x-rate-limit: user-hour-lim:3600;user-hour-rem:3577;
```
Observations:
```json
{
  "resource": {
    "type": "betaTesters",
    "id": "8d056895-40ba-4c32-a302-9fdb01cc08ac",
    "attributeKeys": [
      "lastName",
      "firstName",
      "inviteType",
      "state",
      "appDevices",
      "email"
    ],
    "relationshipKeys": [
      "betaGroups",
      "builds",
      "apps"
    ],
    "sampleAttributes": {
      "lastName": "Mooney",
      "firstName": "Ted",
      "inviteType": "EMAIL",
      "state": null,
      "appDevices": null,
      "email": "ted@travelwincorp.com"
    },
    "relationshipPreview": {
      "betaGroups": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "builds": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      },
      "apps": {
        "hasData": false,
        "dataShape": "undefined",
        "links": [
          "self",
          "related"
        ]
      }
    }
  },
  "hasEmail": true,
  "hasFirstName": true,
  "hasLastName": true,
  "attributeKeys": [
    "lastName",
    "firstName",
    "inviteType",
    "state",
    "appDevices",
    "email"
  ]
}
```

## 09. Pagination probe (limit=2 + walk next once)

Status: **OK**
Note: page1 returned 2, page2 returned 2
Observations:
```json
{
  "page1Links": {
    "self": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackCrashSubmissions?sort=-createdDate&limit=2",
    "next": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackCrashSubmissions?sort=-createdDate&cursor=ASsA1P8ACigIxuPHkhkSBjICCAFwARjO3_O-zjMiEQCO7d-eFSLUXEcMwCz20hMq&limit=2"
  },
  "page2Links": {
    "self": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackCrashSubmissions?sort=-createdDate&cursor=ASsA1P8ACigIxuPHkhkSBjICCAFwARjO3_O-zjMiEQCO7d-eFSLUXEcMwCz20hMq&limit=2",
    "first": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackCrashSubmissions?sort=-createdDate&limit=2",
    "next": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackCrashSubmissions?sort=-createdDate&cursor=Y-DS4Dj2-PgkSSE2IyYOxgJGiYMXzp04a6wkyKAn8ElZyuC-7LqWljV-K9uYAA%3D%3D&limit=2"
  },
  "cursorPattern": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/betaFeedbackCrashSubmissions?sort=-createdDate&cursor=ASsA1P8ACigIxuPHkhkSBjICCAFwARjO3_O-zjMiEQCO7d-eFSLUXEcMwCz20hMq&limit=2"
}
```

## 10. Webhooks read-only probe (per-app)

Status: **OK**
Note: /v1/apps/6749811142/webhooks returned 0
Raw response: `tmp\asc-probe\10-webhooks.json`
Observations:
```json
{
  "workingPath": "/v1/apps/6749811142/webhooks",
  "attemptedPaths": [
    "/v1/apps/6749811142/webhooks",
    "/v1/apps/6749811142/relationships/webhooks"
  ],
  "sampleResource": [],
  "results": [
    {
      "path": "/v1/apps/6749811142/webhooks",
      "status": 200,
      "hasData": true,
      "body": {
        "data": [],
        "links": {
          "self": "https://api.appstoreconnect.apple.com/v1/apps/6749811142/webhooks"
        },
        "meta": {
          "paging": {
            "total": 0,
            "limit": 50
          }
        }
      }
    }
  ]
}
```
