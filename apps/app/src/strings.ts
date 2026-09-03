/**
 * Every word the app's chrome says, in one place.
 *
 * WHY THIS EXISTS. The Roman-Urdu decision is settled (docs/PLAN.md's Urdu
 * decision; docs/assumptions.md #8–#9): the scanner will speak Roman Urdu in
 * Latin script, because Nastaliq breaks the font stack and the row heights,
 * and Roman Urdu is how the staff already type to each other. Translation is
 * NOT done yet — this table is the seam that makes it cheap. A second table
 * (STR_UR) will mirror this exact shape later; until then, extracting every
 * hardcoded English string here is what stops each new commit making the
 * retrofit more expensive.
 *
 * ONE HONEST RULE: keys mirror the CURRENT English text exactly. This file is
 * an extraction, not a rewording — if a sentence reads oddly, it read oddly
 * on screen before this file existed, and fixing it is a separate change.
 *
 * WHAT LIVES ELSEWHERE, DELIBERATELY. The other place words live is the
 * share-content builders — text that leaves the app in a WhatsApp message or
 * a QR code rather than being rendered as chrome: OVERDUE_NUDGE_TEMPLATE and
 * the reply/share text in packages/core, and the parchi / prove-it / manifest
 * / day-account text builders (apps/app/src/parchi.ts, prove-it.ts,
 * session-summary.ts, demo/hisaab.ts). Those stay where they are: they are
 * content the vendor sends, not chrome the app shows, and several are already
 * Roman Urdu. Pure-logic label maps consumed by tests (status.ts LABEL,
 * @papa/core syncStatus) also stay put — one home per rule.
 *
 * Parameterised strings are functions of typed args, so the call site cannot
 * drift from the sentence shape. Grouped by screen: today*, scan*, session*,
 * gear*, enquiry*, hisaab*, labels*, common*.
 */

/** 's' when a count is not one — the English plural rule, named once. */
const s = (n: number): string => (n === 1 ? '' : 's')

export const STR = {
  // ---------------------------------------------------------------- common
  // Chrome shared across screens: the tab bar, boot states, and the words
  // more than one screen uses for the same fact.
  commonTabToday: 'Today',
  commonTabGear: 'Gear',
  commonTabKitList: 'Kit list',
  commonTabLabels: 'Labels',
  commonNavMainAria: 'Main',
  commonDbWouldNotStart: 'The local database would not start.',
  commonOpeningWarehouse: 'Opening the warehouse…',
  commonClose: 'Close',
  commonBackToToday: 'Back to today',
  commonUnknownItem: 'Unknown item',
  commonItemsStillOut: (n: number): string => `${n} item${s(n)} still out`,
  commonPressAndHoldAria: (label: string): string => `${label} — press and hold`,
  commonAppName: 'Papa Vendor',

  // ---------------------------------------------------------------- today
  // The board: counters, the going-out list, coming back, the quick grid,
  // the walk-in job sheet and the due-date editor.
  todaySearchGearAria: 'Search the gear',
  todayStatOutNow: 'out now',
  todayStatOnTheShelf: 'on the shelf',
  todayStatOverdue: 'overdue',
  todayStatNeedALook: 'need a look',
  todayGoingOutToday: 'Going out today',
  todayNothingScheduled: 'Nothing scheduled',
  todayJobsPacked: (jobs: number, scanned: number, expected: number): string =>
    `${jobs} job${s(jobs)} · ${scanned} of ${expected} items packed`,
  todayNewJob: 'New job',
  todayNothingScheduledToday: 'Nothing scheduled today.',
  todayStartAJob: 'Start a job to scan gear out, or scan anything to see where it is.',
  todayJustScan: 'Just scan',
  todayPacked: 'Packed',
  todayInProgress: 'In progress',
  todayLastHandover: 'Last handover',
  todayComingBack: 'Coming back',
  todayTapOneToBookBack: 'Tap one to book its gear back in',
  todayNudgeOnWhatsApp: 'Nudge on WhatsApp',
  todayQuick: 'Quick',
  todayWhereIsThisThing: 'Where is this thing?',
  todayDinKaHisaab: 'Din ka hisaab',
  todayWhatMovedToday: 'What moved today',
  todayLoadYourGear: 'Load your gear',
  todayPasteAListFromExcel: 'Paste a list from Excel',
  todayAnswerAKitList: 'Answer a kit list',
  todayPasteFromWhatsApp: 'Paste from WhatsApp',
  todayAllTheGear: 'All the gear',
  todaySearchByNameOrCode: 'Search by name or code',
  todayCall: 'Call',
  todayCallAria: (contact: string): string => `Call ${contact}`,
  todayWhatsApp: 'WhatsApp',
  todayWhatsAppAria: (contact: string): string => `WhatsApp ${contact}`,
  todayChangeDate: 'Change date',
  todaySetADate: 'Set a date',
  todayExpectedBack: 'Expected back',
  todayExpectedBackDateAria: 'Expected back date',
  todayCurrentlyANote: (note: string): string =>
    `Currently a note: “${note}”. Picking a date replaces it.`,
  todayClearDate: 'Clear date',
  todaySave: 'Save',
  todayWhatIsTheJob: 'What is the job?',
  todayJobLabelPlaceholder: 'e.g. Music video — Gulberg',
  todayContactOptional: 'Contact (optional)',
  todayContactPlaceholder: 'Name and number — e.g. Bilal 0300 4412233',
  todayExpectedBackOptional: 'Expected back (optional)',
  todayCreateJob: 'Create job',

  // ----------------------------------------------------------------- scan
  // The scan screen, the lookup loop, the camera, the manual-add sheet, the
  // case-manifest sheet and the condition-photo sheet.
  scanGoingOut: 'Going out',
  scanComingBack: 'Coming back',
  scanLooseScan: 'Loose scan',
  scanThisItem: 'this item',
  scanPhotographAria: (name: string): string => `Photograph ${name}`,
  scanAddAnyway: 'Add anyway',
  scanNotThisJob: 'Not this job',
  scanAttachThisLabel: 'Attach this label',
  scanTorchOffAria: 'Turn torch off',
  scanTorchOnAria: 'Turn torch on',
  scanListAsOf: (age: string): string => `List as of ${age} · not refreshed`,
  scanCantScanIt: 'Can’t scan it',
  scanHoldToFinishLeft: (remaining: number): string =>
    `Hold to finish · ${remaining} left`,
  scanHoldToFinish: 'Hold to finish',
  scanAddedToThisJob: 'Added to this job',
  scanLeftOffThisJob: 'Left off this job',
  scanDeviceFull: (waiting: number): string =>
    `Device full — ${waiting} photo${s(waiting)} still waiting to send. ` +
    'Nothing has been deleted. Get this phone online, then try again.',
  scanGotIt: 'Got it',
  scanWhatIsThisLabelOn: 'What is this label on?',
  scanDocTitle: (jobLabel: string): string => `${jobLabel} — Papa Vendor`,
  scanLookupDocTitle: 'Where is this thing? — Papa Vendor',
  scanLabelReportedLost: 'This label was reported lost — nothing recorded',
  scanLabelRetired: 'This label was retired — nothing recorded',
  scanNotOnThisPhoneYet: 'Not on this phone yet — nothing recorded',
  scanUnknownLabel: 'Unknown label — nothing recorded',
  scanOnlyLooking: 'Only looking — nothing is recorded',
  scanManualPlaceholder: 'Code or name — e.g. FX9 or Aputure',
  scanTypeAFewLetters: 'Type a few letters of the code or the name.',
  scanNothingMatchesQuery: (query: string): string => `Nothing matches “${query}”.`,
  scanDeskDecoder: 'Desk decoder',
  scanStartingCamera: 'Starting camera…',
  scanNeedsSecurePageOpenOn: 'The camera needs a secure page. Open this on',
  scanOrStartTheServerWith: ', or start the server with',
  scanPermissionRefused: 'Camera permission was refused. Allow it and reload.',
  scanCameraWouldNotStart: 'Camera would not start.',
  scanPhotoSecurePage:
    'The camera needs a secure page — open this on localhost or over https.',
  scanPhotoNotEncoded: 'The photo could not be encoded.',
  scanPhotoNotReadBack: 'The photo could not be read back.',
  scanHowItLooksGoingOut: 'How it looks going out',
  scanHowItCameBack: 'How it came back',
  scanSaving: 'Saving…',
  scanTakeThePhoto: 'Take the photo',
  scanTimedByThisPhone:
    'Timed by this phone’s clock. The server stamps its own time when it arrives.',
  scanWhatIsInThisCase: 'What is in this case',
  scanCaseFallback: 'Case',
  scanBelievedInside: (n: number): string => `${n} item${s(n)} believed inside`,
  scanPartOfTheCase: 'Part of the case',
  scanCannotLeaveWithoutIt:
    'These cannot leave without it, so they are recorded with the case.',
  scanPackedInside: 'Packed inside — not looked at',
  scanThemOneByOne: 'Scan them one by one',
  scanTakeTheRestAsPacked: (unchecked: number): string =>
    `Take the rest as packed · ${unchecked} unchecked`,
  scanTakeTheCaseAsPacked: (unchecked: number): string =>
    `Take the case as packed · ${unchecked} unchecked`,
  scanTakingAsPackedRecords: 'Taking it as packed records those items as',
  scanAssumedWord: 'assumed',
  scanCountedSeparately:
    '. They are counted separately and are not used as evidence if this job turns into a damage claim.',
  scanMarkedNotInHere: (excluded: number): string =>
    `${excluded === 1 ? 'One item' : `${excluded} items`} marked not in here ` +
    'will be recorded as nothing at all, and will show as missing on the handover.',
  scanUnnamed: 'Unnamed',
  scanItIsHere: 'It is here',
  scanNotInHere: 'Not in here',

  // -------------------------------------------------------------- session
  // The handover summary and the full-screen parchi.
  sessionHandover: 'Handover',
  sessionNothingOpen: 'Nothing open',
  sessionNothingScannedYet: 'Nothing has been scanned on this job yet.',
  sessionScanAndItWillBeHere:
    'Scan gear out or back in and the handover summary will be here — finished sessions stay reviewable from the job card.',
  sessionItems: 'items',
  sessionBack: 'back',
  sessionScanned: 'scanned',
  sessionByCase: 'by case',
  sessionStillOut: 'still out',
  sessionNotAccountedFor: 'not accounted for',
  sessionEverythingCameBack: 'Everything that went out has come back.',
  sessionEverythingAccountedFor: 'Everything on the list is accounted for.',
  sessionWorthACall: 'Still with the client, or not found. Worth a call today.',
  sessionRestCanFollow:
    'The rest can follow on a second run. This is a tally, not a verdict.',
  sessionConfirmedByCase: (n: number): string => `${n} confirmed by case, not seen.`,
  sessionABeliefNotAnObservation:
    'These are a belief, not an observation. They are excluded if this job ever turns into a damage claim.',
  sessionNeedsAWord: 'Needs a word',
  sessionRecordedEitherWay: 'Recorded either way',
  sessionDidNotComeBack: 'Did not come back',
  sessionStillOnTheShelf: 'Still on the shelf',
  sessionMoneyNotBack: (money: string): string =>
    `${money} not back · went out on this job, not scanned in`,
  sessionMoneyNotInVan: (money: string): string =>
    `${money} of day rate on the list, not in the van`,
  sessionWentOutNotScannedIn: 'Went out on this job, not scanned in',
  sessionOnTheListNotInVan: 'On the list, not in the van',
  sessionNoRate: 'no rate',
  sessionSendWhatIsStillOut: 'Send what is still out',
  sessionSendTheListOnWhatsApp: 'Send the list on WhatsApp',
  sessionParchiShowAtTheGate: 'Parchi — show at the gate',
  sessionKeepScanning: 'Keep scanning',
  sessionDoneForNow: 'Done for now',
  sessionNothingHereClosesTheJob:
    'Nothing here closes the job or releases a deposit. That happens at the desk, after someone has looked at the gear.',
  sessionNothingHereConfirms:
    'Nothing here confirms the dispatch. The desk does that later, with the money attached — it never holds up the truck.',
  sessionParchiGatePassAria: 'Parchi — gate pass',
  sessionChallanAsQrAlt: 'The challan as a QR code',
  sessionAnyPhoneCameraReadsThis:
    'Any phone camera reads this — the challan text opens directly, no app needed. Tap anywhere to close.',

  // ----------------------------------------------------------------- gear
  // The inventory list, the asset page and the photo comparison.
  gearTitle: 'Gear',
  gearSubtitle: 'Everything the house owns',
  gearItemFallback: 'Item',
  gearBackToTheGearAria: 'Back to the gear',
  gearFilterEverything: 'Everything',
  gearFilterOnTheShelf: 'On the shelf',
  gearFilterOut: 'Out',
  gearFilterNeedsALook: 'Needs a look',
  gearSearchPlaceholder: 'Search by name or code — FX9, AP600, battery',
  gearClearSearchAria: 'Clear search',
  gearItemCount: (n: number): string => `${n} item${s(n)}`,
  gearKindsSuffix: (kinds: number): string => ` · ${kinds} kinds`,
  gearNothingMatches: 'Nothing matches.',
  gearNoGearCalled: (query: string): string => `No gear called “${query}”.`,
  gearNothingInThisFilter: 'Nothing in this filter right now.',
  gearSomewhereHere: 'Somewhere here',
  gearOutFallback: 'Out',
  gearNoSuchItem: 'No such item.',
  gearBackToTheGear: 'Back to the gear',
  gearFactCategory: 'Category',
  gearFactShelf: 'Shelf',
  gearFactSerial: 'Serial',
  gearSerialNotRecorded: 'not recorded',
  gearFactTag: 'Tag',
  gearNoTag: 'no tag',
  gearProveIt: 'Prove it — share this item’s record',
  gearCondition: 'Condition',
  gearNothingPhotographed: 'Nothing photographed',
  gearOutBesideBack: 'What it looked like going out, beside how it came back',
  gearHistory: 'History',
  gearNothingRecordedYet: 'Nothing recorded yet',
  gearEntriesNewestFirst: (n: number): string =>
    `${n} entr${n === 1 ? 'y' : 'ies'}, newest first`,
  gearItemHasNotMovedYet: 'This item has not moved yet.',
  gearScanItOutAndItShowsUp: 'Scan it out on a job and it will show up here.',
  gearMethodScanned: 'scanned',
  gearMethodManual: 'typed in by hand',
  gearMethodAssumed: 'assumed — in a case, not seen',
  gearMethodImplied: 'moved with its parent',
  gearMethodCounted: 'counted',
  gearEventWentOut: 'Went out',
  gearEventCameBack: 'Came back',
  gearEventIntake: 'Added to the fleet',
  gearEventMove: 'Moved',
  gearNoConditionPhotosYet: 'No condition photos yet.',
  gearPhotographOutAndBack:
    'Photograph an item on the way out and again on the way back, and the two sit side by side here.',
  gearGoingOutLabel: 'Going out',
  gearComingBackLabel: 'Coming back',
  gearNoPhotoGoingOut: 'No photo going out',
  gearNotPhotographedBackYet: 'Not photographed back yet',
  gearWentOutNoMatchingPhoto:
    'This went out with a photo and has no matching one coming back.',
  gearPhotographedOnReturnOnly:
    'Photographed on return only — there is nothing to compare it against.',
  gearConditionPhotoAlt: (label: string): string => `${label} condition photo`,
  gearByThisPhonesClock: 'by this phone’s clock',
  gearOnlyOnThisPhone: 'only on this phone',

  // -------------------------------------------------------------- enquiry
  // The kit-list reader.
  enquiryTitle: 'Kit list',
  enquirySubtitle: 'Paste what the client sent',
  enquiryPastePlaceholder:
    'Paste the client’s message here…\n\nGreetings and “please confirm” are ignored automatically.',
  enquiryCheckAvailability: 'Check availability',
  enquiryNewList: 'New list',
  enquiryEverythingIsAvailable: 'Everything is available',
  enquiryNeedALook: (n: number): string => `${n} need${n === 1 ? 's' : ''} a look`,
  enquiryTheyWrote: (raw: string): string => `they wrote: “${raw}”`,
  enquiryOnlyNOfMHere: (onHand: number, wanted: number): string =>
    `only ${onHand} of ${wanted} here`,
  enquiryNoneOnTheShelf: 'none on the shelf',
  enquiryCopyReply: 'Copy reply',
  enquiryMakeAJobFromThis: 'Make a job from this',
  enquiryLinesGoOnTheJob: (units: number, lines: number): string =>
    `${units} item${s(units)} from ${lines} line${s(lines)} go on the job.`,
  enquiryUnconfirmedLeftOut: (base: string, unresolved: number): string =>
    `${base} ${unresolved} unconfirmed line${s(unresolved)} left out — resolve them first if they belong.`,

  // --------------------------------------------------------------- hisaab
  // Din ka hisaab — the day's account on screen.
  hisaabTitle: 'Din ka hisaab',
  hisaabStatWentOut: 'went out',
  hisaabStatCameBack: 'came back',
  hisaabStatOnTrust: 'on trust',
  hisaabStatPhotos: 'photos',
  hisaabCopied: 'Copied — paste it in WhatsApp',
  hisaabCopyTheDaysAccount: "Copy the day's account",
  hisaabUnknownLabelsScanned: (n: number): string =>
    `${n} unknown label${s(n)} scanned today.`,
  hisaabLabelsNeverSeen:
    'Labels this phone has never seen. Recorded, waiting to be identified.',
  hisaabNothingToday: 'Nothing scanned or photographed today yet.',
  hisaabTheAccountFillsItself:
    'The account fills itself as gear is scanned out and back. What is still out from earlier days is listed below.',
  hisaabWentOutHeading: 'Went out',
  hisaabCameBackHeading: 'Came back',
  hisaabNOut: (n: number): string => `${n} out`,
  hisaabNBack: (n: number): string => `${n} back`,
  hisaabNPhotos: (n: number): string => `${n} photo${s(n)}`,
  hisaabPhotographedOnly: 'Photographed only',
  hisaabStillOut: 'Still out',
  hisaabEverythingIsHome: 'Everything is home',
  hisaabWithTheClient: 'With the client — the due label says since when',
  hisaabOnTrustCount: (n: number): string => ` · ${n} on trust`,
  hisaabTakenOnTrust: 'Taken on trust — not seen',

  // --------------------------------------------------------------- labels
  // The label sheet, plus the catalogue import that lives under this tab.
  labelsTitle: 'Labels',
  labelsSubtitle: (tags: number): string =>
    `${tags} tags · print, or open on another screen`,
  labelsPrintTheseHint:
    'Print these onto sticker paper and put one on each item. Then scan a label and tap',
  labelsAttachThisLabel: 'Attach this label',
  labelsToSayWhatItIsOn: 'to say what it is on.',
  labelsDrawingLabels: 'Drawing labels…',
  labelsPrintTheLabels: 'Print the labels',
  labelsLoadYourGear: 'Load your gear',
  labelsImportSubtitle: 'Paste a list, check it, then add it',
  labelsImportLead:
    'Paste your gear list — straight out of Excel, Google Sheets, or a CSV. Nothing is saved until you have seen what it would do.',
  labelsImportPlaceholder: 'Item Description,Qty,Asset Code,Shelf\nSony FX9,2,FX9,Rack A\n…',
  labelsTryASampleList: 'Try it with a sample list',
  labelsStartAgain: 'Start again',
  labelsCheckTheColumns: 'Check the columns',
  labelsRowsTheseAreGuesses: (rows: number): string =>
    `${rows} row${s(rows)} · these are guesses`,
  labelsRequired: 'required',
  labelsNotInThisFile: '— not in this file —',
  labelsColumnN: (n: number): string => `Column ${n}`,
  labelsWhichColumnIsTheName: 'Which column is the product name?',
  labelsNothingCanBeRead: 'Nothing can be read until that one is set.',
  labelsFieldProductName: 'Product name',
  labelsFieldAssetCode: 'Asset code',
  labelsFieldSerialNumber: 'Serial number',
  labelsFieldCategory: 'Category',
  labelsFieldHowMany: 'How many',
  labelsFieldShelf: 'Shelf',
  labelsWhatThisWouldDo: 'What this would do',
  labelsNothingIsSavedYet: 'Nothing is saved yet',
  labelsStatNewProducts: 'new products',
  labelsStatAlreadyKnown: 'already known',
  labelsStatNeedALook: 'need a look',
  labelsStatUnusable: 'unusable',
  labelsLineN: (n: number): string => `Line ${n}`,
  labelsCloseTo: (candidates: string): string =>
    `Close to ${candidates} — left as its own product`,
  labelsLineNCode: (n: number): string => `line ${n}`,
  labelsAddNItems: (n: number): string => `Add ${n} item${s(n)}`,
  labelsRowsMarkedNeedALook:
    'Rows marked “need a look” are added as their own product rather than merged into a similar one. Nothing here overwrites what you already have.',
  labelsAddedAcross: (units: number, products: number): string =>
    `Added ${units} item${s(units)} across ${products} new product${s(products)}.`,
  labelsYourNamesAreNowMatched:
    'Your names are now what the kit-list reader matches a client’s message against.',
  labelsSeeTheGear: 'See the gear',
  labelsLoadAnotherList: 'Load another list',
} as const
