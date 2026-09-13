/**
 * Every word the app's chrome says, in one place.
 *
 * WHY THIS EXISTS. The Roman-Urdu decision is settled (docs/PLAN.md's Urdu
 * decision; docs/assumptions.md #8–#9): the scanner speaks Roman Urdu in
 * Latin script, because Nastaliq breaks the font stack and the row heights,
 * and Roman Urdu is how the staff already type to each other. The second
 * table lives in strings-ur.ts and mirrors this exact shape — the annotation
 * on STR_UR makes a missing or misshapen key a compile error, not a blank
 * label found in the warehouse.
 *
 * THE EXPORTED `STR` IS THE ACTIVE TABLE, chosen once at module load from the
 * persisted choice (lang.ts). Nothing else about the seam changed: components
 * keep importing STR exactly as before, and a language switch re-evaluates the
 * app (a reload) rather than threading state through every screen. English is
 * the default, so every test that asserts literal English text is asserting
 * the table a fresh install actually shows.
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
 * gear*, enquiry*, hisaab*, labels*, common*, booking*, quote*.
 */

import { getLang } from './lang.ts'
import { STR_UR } from './strings-ur.ts'

/** 's' when a count is not one — the English plural rule, named once. */
const s = (n: number): string => (n === 1 ? '' : 's')

/**
 * The ledger's row vocabulary, one word per entry kind. A lookup rather
 * than eight keys because the kind arrives as data from the book and the
 * fallback must be the kind itself, never a blank row.
 */
const KIND_EN: Record<string, string> = {
  charge: 'charge',
  payment: 'payment',
  deposit_hold: 'deposit held',
  deposit_apply: 'deposit applied',
  deposit_refund: 'deposit refunded',
  late_fee: 'late fee',
  damage_charge: 'damage',
  adjustment: 'adjustment',
  // The correction vocabulary: a reversal voids a named earlier entry (a
  // bounced cheque reads 'reversed', never 'adjustment' — the house did
  // not make the error), and a write-off is given-up debt, not a data fix.
  reversal: 'reversed',
  write_off: 'write-off',
}

/** The overdue ladder's rungs, by the action each day asks for. */
const ESCALATION_EN: Record<string, string> = {
  whatsapp_nudge: 'first nudge',
  call: 'time to call',
  late_fee_draft: 'late fee due',
  manager_escalation: 'with the manager',
}

/**
 * The expense book's row vocabulary (0019) — same lookup shape as KIND_EN:
 * the kind arrives as data and the fallback must be the kind itself.
 */
const KHARCHA_EN: Record<string, string> = {
  repair: 'repair',
  sub_hire: 'sub-hire',
  purchase: 'purchase',
  transport: 'transport',
  consumables: 'consumables',
  misc: 'other',
}

/**
 * The English table. NOT `as const`: the literal types would make every other
 * language table a type error, and nothing consumes the literals. What the
 * annotation on STR_UR needs is exactly what this widened shape provides —
 * same keys, same function signatures.
 */
const STR_EN = {
  // ---------------------------------------------------------------- common
  // Chrome shared across screens: the tab bar, boot states, and the words
  // more than one screen uses for the same fact.
  commonTabToday: 'Today',
  commonTabGear: 'Gear',
  commonTabDesk: 'Desk',
  commonTabKhata: 'Khata',
  commonSettings: 'Settings',
  commonSettingsSubtitle: 'Language, labels, backup, getting paid',
  commonOpenSettingsAria: 'Open settings',
  commonNavMainAria: 'Main',
  commonDbWouldNotStart: 'The local database would not start.',
  commonOpeningWarehouse: 'Opening the warehouse…',
  commonClose: 'Close',
  commonBackToToday: 'Back to today',
  commonUnknownItem: 'Unknown item',
  commonItemsStillOut: (n: number): string => `${n} item${s(n)} still out`,
  commonPressAndHoldAria: (label: string): string => `${label} — press and hold`,
  commonAppName: 'Papa Vendor',
  // The language row on the settings surface. The two option names are
  // deliberately the same words in both tables — each choice must be readable
  // in the language the screen is currently NOT in.
  commonLanguage: 'Language',
  commonLanguageEnglish: 'English',
  commonLanguageRomanUrdu: 'Roman Urdu',
  commonLanguageSub: 'Choose once — the app reopens in that language',

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
  // The customer picker on the new-job sheet. Optional on purpose — the
  // nephew case (a job with no customer) stays legal; it just cannot take
  // a charge, and the sheet says so instead of forcing a fake name.
  todayCustomerOptional: 'Customer (optional)',
  todayNoCustomer: 'No customer',
  todayNoCustomerHint: 'Without a customer this job cannot take a charge.',
  todayNewCustomer: 'New customer',
  todayCustomerNameLabel: 'Customer name',
  todayCustomerNamePlaceholder: 'e.g. Bilal Hussain',
  todayCustomerPhoneOptional: 'Phone (optional)',
  todayOpenKhataAria: (name: string): string => `Open ${name}’s khata`,
  // Closing a job — the end the year simulation had to fake with SQL.
  todayCloseJob: 'Close job',
  todayStillOutCannotClose: (n: number): string => `${n} item${s(n)} still out`,
  // The money strip — the board's third glance, from the local ledger.
  todayMoneyHeading: 'Money',
  todayMoneyOwedToMe: 'owed to me',
  todayMoneyDueInToday: 'due in today',
  todayMoneyEarnedThisMonth: 'earned this month',
  todayMoneyOwedAria: 'Owed to me — open the list',

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
  // Charge-from-the-dock and the late-fee draft (Phase B item 3). Money
  // written here is a PAST FACT agreed at the dock; nothing auto-charges.
  sessionChargeClient: 'Charge client',
  sessionChargeAria: (name: string): string => `Charge client for ${name}`,
  sessionChargeAmount: 'Amount (Rs)',
  sessionChargeNoteOptional: 'Note (optional)',
  sessionWriteInKhata: 'Write it in the khata',
  sessionChargeGoesTo: (name: string): string => `Goes on ${name}’s khata`,
  sessionCameBackLate: 'Came back late',
  sessionLateFeeSub: (dueLabel: string, rate: string): string =>
    `${dueLabel} · day rate ${rate} per day`,
  sessionLateFeeNeverAuto:
    'A draft — you confirm the figure. Nothing is charged on its own.',
  sessionDraftLateFee: 'Draft a late fee',
  sessionLateFee: 'Late fee',
  sessionUnpricedNotInFee: (n: number): string =>
    `${n} item${s(n)} carry no day rate and are not in this figure.`,
  sessionChargeWritten: (name: string): string => `Written in ${name}’s khata`,
  sessionViewKhata: 'Open the khata',

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
  gearFilterGone: 'Gone',
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
  // The asset page's money section: earnings, the payback bar, demand.
  gearMoneyHeading: 'Money',
  gearEarnedAcross: (rupees: string, jobs: number): string =>
    `Earned ${rupees} across ${jobs} job${s(jobs)}`,
  gearNothingEarnedYet:
    'Nothing earned yet — a charge naming this unit lands here.',
  // "Cost", not "replacement value": since the kharcha book (0019) the
  // bar's denominator is the replacement value PLUS the unit's repairs.
  gearPaybackLabel: (pct: number): string =>
    `${pct}% of its cost earned back`,
  gearPaidForItself: 'This one has paid for itself.',
  gearNoReplacementValue: 'No replacement value on record, so no payback bar.',
  gearTurnedAway: (times: number): string =>
    `Turned away ${times}× this month`,

  // -------------------------------------------------------------- enquiry
  // The kit-list reader.
  enquiryTitle: 'Kit list',
  enquirySubtitle: 'Paste what the client sent',
  enquiryPastePlaceholder:
    'Paste the client’s message here…\n\nGreetings and “please confirm” are ignored automatically.',
  enquiryPasteAria: 'The client’s message',
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
  labelsImportDoor: 'Load your gear from a list',
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
  labelsImportAria: 'Your gear list',
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
  labelsCodesContinued: (n: number): string =>
    `${n} asset code${s(n)} ${n === 1 ? 'was' : 'were'} already in use — ` +
    'numbering continued instead of duplicating a sticker code.',
  labelsYourNamesAreNowMatched:
    'Your names are now what the kit-list reader matches a client’s message against.',
  labelsSeeTheGear: 'See the gear',
  labelsLoadAnotherList: 'Load another list',
  // The backed-up chip and the payment settings, on the settings surface.
  labelsBackedUpHeading: 'Backed up',
  labelsQueueStatus: (n: number): string =>
    n === 0
      ? 'Queue empty · demo mode — nothing leaves this device'
      : `${n} scan${s(n)} queued · demo mode — nothing leaves this device`,
  labelsPaymentHeading: 'Getting paid',
  labelsPaymentSub: 'The line and the QR every statement carries',
  labelsPaymentLineLabel: 'Payment line for statements',
  labelsPaymentLinePlaceholder: 'e.g. JazzCash: 0300 1234567',
  labelsPaymentLineHint:
    'Written under every balance card and statement once set.',
  labelsPaymentQrLabel: 'Payment QR',
  labelsAttachQr: 'Attach a QR image',
  labelsRemoveQr: 'Remove the QR',
  labelsQrStored: 'Stored on this device only.',
  labelsSave: 'Save',
  labelsSaved: 'Saved',

  // ------------------------------------------------------------- customer
  // The khata page, the owed list, and the two money documents (the
  // balance card and the monthly statement — see @papa/core ledger.ts).
  customerKhata: 'Khata',
  customerNoSuchCustomer: 'No such customer.',
  customerBalanceHeading: 'Balance',
  customerDepositHeldLine: (rupees: string): string => `Deposit held: ${rupees}`,
  customerRecordPayment: 'Record payment',
  customerSendBalance: 'Send balance',
  customerMonthlyStatement: 'Monthly statement',
  customerCopied: 'Copied — paste it in WhatsApp',
  customerBookHeading: 'The book',
  customerEntriesNewestFirst: (n: number): string =>
    `${n} entr${n === 1 ? 'y' : 'ies'}, newest first`,
  customerNothingInBook: 'Nothing in the book yet.',
  customerLinkedJobs: 'Jobs',
  customerJobClosed: 'closed',
  customerPaymentAmount: 'Amount (Rs)',
  customerPaymentNoteOptional: 'Note (optional)',
  customerSavePayment: 'Record the payment',
  customerMethodCash: 'Cash',
  customerMethodJazzCash: 'JazzCash',
  customerMethodEasypaisa: 'Easypaisa',
  customerMethodBank: 'Bank',
  customerOwedTitle: 'Owed to me',
  customerOwedSubtitle: (n: number): string => `${n} customer${s(n)} owing`,
  customerNobodyOwes: 'Nobody owes anything right now.',
  customerOwedTapOne: 'Tap a name to open the khata',
  customerCardTitle: (name: string): string => `Hisaab — ${name}`,
  customerStatementTitle: (name: string, month: string): string =>
    `Statement — ${name} · ${month}`,
  customerCardBalanceLine: (rupees: string): string => `Balance: ${rupees}`,
  customerStatementClosingLine: (rupees: string): string =>
    `Closing balance: ${rupees}`,
  customerNothingOwed: 'Nothing owed',
  // POLICY (owner may overrule): a negative balance is the house's own
  // debt and is said plainly — never disguised as 'Nothing owed'.
  customerHouseOwes: (rupees: string): string => `You owe them ${rupees}`,
  customerOwedSince: (date: string): string => `Owed since ${date}`,
  customerKindLabel: (kind: string): string => KIND_EN[kind] ?? kind,
  customerNothingThisMonth: 'Nothing recorded this month.',
  // Charged-then-returned: the NEEDS-A-DECISION notice and its one-tap
  // correction draft. POLICY (owner may overrule): a notice, never an
  // auto-reverse — see chargedButReturned in demo/khata.ts.
  customerChargedButReturned: (rupees: string, code: string, job: string): string =>
    `Charged ${rupees} for ${code} on ${job} — it came back. Reverse?`,
  customerReverseDraft: 'Reverse…',
  customerReverseConfirm: (rupees: string): string =>
    `Confirm — write ${rupees} back`,
  customerReversedNote: 'Charged, then it came back — reversed',

  // --------------------------------------------------------------- kharcha
  // The expense side of the book (0019): the entry sheet, the asset page's
  // cost line, the job margin line, and the hisaab's Kharcha + month block.
  kharchaHeading: 'Kharcha',
  kharchaAddExpense: 'Add expense',
  kharchaRepairCost: 'Repair cost',
  kharchaKindLabel: (kind: string): string => KHARCHA_EN[kind] ?? kind,
  kharchaAmount: 'Amount (Rs)',
  kharchaPaidToOptional: 'Paid to (optional)',
  kharchaPaidToPlaceholder: 'e.g. Sharif Camera Works',
  kharchaNoteOptional: 'Note (optional)',
  // Backdatable, like a payment: "paid the workshop last Tuesday,
  // recording it now" must land on the day the money actually left.
  kharchaDatePaid: 'Date paid',
  kharchaDatePaidHint:
    'Paid on an earlier day? Set the date and the book files it there.',
  kharchaSaveExpense: 'Record the expense',
  kharchaForAsset: (code: string): string =>
    `For ${code} — lands in its cost history`,
  // The asset page's cost line, under the earnings: the other half of the
  // payback question.
  kharchaAssetCost: (rupees: string, repairs: number): string =>
    `Cost ${rupees} (purchase + ${repairs} repair${s(repairs)})`,
  kharchaAssetRepairsOnly: (rupees: string, repairs: number): string =>
    `Repairs ${rupees} (${repairs}×) — no purchase value on record`,
  // Margin at a glance on the job's handover, shown when the job carries
  // expenses: what it billed beside what it cost.
  kharchaJobMarginLine: (earned: string, costs: string): string =>
    `Earned ${earned} · costs ${costs}`,
  kharchaDaySpent: (rupees: string): string => `${rupees} spent today`,
  kharchaDayNone: 'No kharcha recorded today.',
  kharchaMonthHeading: 'Mahine ka hisaab',
  kharchaMonthEarned: 'Earned',
  kharchaMonthSpent: 'Kharcha',
  // The month's bottom line, double-ruled like the balance: the
  // vendor's-dream figure, earned minus spent.
  kharchaMonthProfitLabel: 'Profit — earned minus kharcha',
  kharchaNoExpensesThisMonth: 'No expenses recorded this month.',
  kharchaReversedNote: 'Entered wrong — reversed',

  // --------------------------------------------------------------- closed
  // The "Closed jobs" door — the smallest honest surface for jobs that
  // ended: off the boards, still findable, reopenable when the story
  // continues.
  closedJobsTitle: 'Closed jobs',
  closedJobsSubtitle: (n: number): string => `${n} job${s(n)} finished`,
  closedJobsEmpty: 'No closed jobs yet.',
  closedJobsEmptyHint: 'Close a job from its card once everything is back.',
  closedJobsDoor: 'Closed jobs',
  closedJobsReopen: 'Reopen',
  closedJobsClosedOn: (date: string): string => `Closed ${date}`,
  closedJobsNeverCameBack: (n: number): string =>
    `${n} item${s(n)} never came back`,

  // ----------------------------------------------------------------- fleet
  // The lifecycle surface (0020): declaring gear terminal, the theft report,
  // the crisis-day swap, and the ginti (cycle count). Everything destructive
  // here is behind a hold, a note and a confirm — the adjacency rules that
  // keep a wet glove from ending a camera's life by mis-tap.
  fleetGoneHeading: 'This item left the fleet',
  fleetDispositionWord: (d: string): string =>
    ({ lost: 'lost', stolen: 'stolen', sold: 'sold', retired: 'retired', returned_to_owner: 'returned to owner' }[d] ?? d),
  // The disclosure the destructive doors hide behind — held open, not tapped.
  fleetMarkGone: 'Mark lost, stolen or sold',
  fleetMarkGoneHint:
    'These take the item off the fleet. Hold to open, then confirm.',
  fleetHoldToReveal: 'Hold to open',
  fleetLost: 'Lost',
  fleetStolen: 'Stolen',
  fleetSold: 'Sold',
  fleetMarkNoteLabel: 'What happened? (optional)',
  fleetSaleAmountLabel: 'Sale amount (Rs, optional)',
  // Deliberately not a ledger line — see 0020 D3. The note is the record
  // until a sale-income book exists.
  fleetSaleAmountHint:
    'Kept as a note on the item — not on the money book yet.',
  fleetConfirmLost: 'Confirm — mark lost',
  fleetConfirmStolen: 'Confirm — mark stolen',
  fleetConfirmSold: 'Confirm — mark sold',
  fleetMarkedNote: (word: string): string => `Marked ${word}`,
  fleetFound: 'Mark found — back in the fleet',
  fleetFoundNote: 'Turned up — back in the fleet',
  // The stamp word on a terminal asset page — LOST / STOLEN / SOLD / RETIRED
  // (the CSS uppercases; these are the translatable lowercase words).
  fleetStampLost: 'lost',
  fleetStampStolen: 'stolen',
  fleetStampSold: 'sold',
  fleetStampRetired: 'retired',
  // --- network --- (0025 D5): a borrowed unit that went home.
  fleetStampReturnedToOwner: 'returned to owner',
  // The theft report (the police / insurance / partner-house card).
  fleetTheftReport: 'Theft report',
  fleetTheftHeading: 'THEFT REPORT',
  fleetTheftBanner: 'This equipment is reported STOLEN.',
  fleetTheftCodeLabel: 'Code',
  fleetTheftSerialLabel: 'Serial',
  fleetTheftNoSerial: 'not recorded',
  fleetTheftPhotos: (n: number): string =>
    n === 0
      ? 'No condition photos on record.'
      : `${n} condition photo${s(n)} on record.`,
  fleetTheftLastSeen: 'Last seen',
  fleetTheftLastSeenLine: (when: string, jobLabel: string | null): string =>
    jobLabel ? `${when} — on ${jobLabel}` : when,
  fleetTheftLastSeenUnknown: 'No scan on record.',
  fleetTheftContact: 'Contact',
  fleetTheftFooter: (houseName: string): string =>
    `Reported by ${houseName}. Please contact us with any information.`,
  // The swap (crisis-day: a substitute onto a live job in one flow).
  fleetSwapOntoJob: 'Swap onto job',
  fleetSwapTitle: 'Swap a substitute in',
  fleetSwapBrokenLine: (code: string, jobLabel: string): string =>
    `${code} comes off ${jobLabel} and gets flagged.`,
  fleetSwapPickSubstitute: 'Pick a substitute',
  fleetSwapSamePreferred: 'Same product, on the shelf',
  fleetSwapOther: 'Anything else on the shelf',
  fleetSwapNoSubstitutes: 'Nothing on the shelf fit to send.',
  fleetSwapConfirm: 'Swap — record both movements',
  fleetSwapDone: (broken: string, sub: string): string =>
    `${sub} out; ${broken} home and flagged.`,
  fleetSwapNoLiveJob: 'This item is not out on a live job to swap off.',
  // The ginti (cycle count / stocktake).
  fleetGinti: 'Ginti',
  fleetGintiSubtitle: 'Count a shelf against the book',
  fleetGintiScanShelf: 'Scan a shelf tag, or pick a shelf, to start',
  fleetGintiPickShelf: 'Pick a shelf',
  fleetGintiCounting: (shelf: string): string => `Counting ${shelf}`,
  fleetGintiSeen: (n: number): string => `${n} seen`,
  fleetGintiOk: (n: number): string => `${n} matched`,
  fleetGintiMissing: (n: number): string => `${n} missing`,
  fleetGintiUnexpected: (n: number): string => `${n} not on this shelf`,
  fleetGintiScanItems: 'Scan items on the shelf',
  fleetGintiFinish: 'Finish the count',
  fleetGintiReportButton: 'Copy the discrepancy report',
  fleetGintiClean: 'Every item on this shelf was found.',
  fleetGintiReportHeading: 'GINTI',
  fleetGintiReportShelf: (shelf: string): string => `Shelf: ${shelf}`,
  fleetGintiReportMissing: 'MISSING (expected, not found):',
  fleetGintiReportUnexpected: 'NOT ON THIS SHELF (found here anyway):',
  fleetGintiReportOkLine: (n: number): string => `${n} matched the book.`,
  fleetGintiReportDecide:
    'Missing items are for you to decide — found elsewhere, or lost.',

  // ---------------------------------------------------------------- sehat
  // The fleet-health surface (0021; Phase D 1–2/6): the usage-service
  // nudge, the cycle ceiling and dead stock — a section on the Gear
  // screen, each row a door to its asset page, plus the asset page's own
  // service and cycle lines and the Serviced sheet. Groups render only
  // when non-empty: a health surface with no findings is noise.
  sehatHeading: 'Sehat',
  sehatSubtitle: 'What the fleet needs looked at',
  sehatServiceDue: 'Service due',
  sehatServiceRow: (days: number, dueAfter: number): string =>
    `${days} rental days · due at ${dueAfter}`,
  sehatCyclesOver: 'Past their cycle ceiling',
  sehatCycleRow: (cycles: number, ceiling: number): string =>
    `${cycles} cycles · ceiling ${ceiling}`,
  sehatDeadStock: (days: number): string => `Idle ${days}+ days`,
  sehatDeadRow: (idleDays: number): string => `idle ${idleDays} days`,
  // The asset page's service line — the usage meter said in words.
  sehatSinceLine: (days: number, dueAfter: number | null): string =>
    dueAfter === null
      ? `${days} rental days since service`
      : `${days} rental days since service · due at ${dueAfter}`,
  sehatNeedsALookStamp: 'Needs a look — past its service point',
  sehatCycleLine: (cycles: number, ceiling: number | null): string =>
    ceiling === null ? `${cycles} cycles recorded` : `${cycles} of ${ceiling} cycles`,
  sehatCycleOverStamp:
    'Past the cycle ceiling — nothing changes on its own; inspect it',
  // The Serviced door: note + optional cost in one flow. A cost writes a
  // repair on the kharcha book named to this unit, and the serviced event
  // carries the link.
  sehatServicedButton: 'Serviced',
  sehatServicedTitle: 'Mark serviced',
  sehatServicedHint: (code: string): string =>
    `Resets ${code}’s service clock. A cost also writes a repair in the kharcha book, named to this unit.`,
  sehatServicedNoteLabel: 'What was done? (optional)',
  sehatServicedCostLabel: 'Cost (Rs, optional)',
  sehatServicedConfirm: 'Confirm — serviced',

  // ---------------------------------------------------------------- awaaz
  // Voice notes (0021; Phase D5 — Bykea's lesson: typing is the barrier).
  // Hold-to-record on the asset page and the return's discrepancy rows;
  // stored like condition photos: never evicted un-uploaded, honest
  // refusal when full, the phone's clock always labelled as the phone's.
  awaazNote: 'Awaaz note',
  awaazHold: 'Hold to record',
  awaazRecording: 'Recording — let go to keep it',
  awaazSaved: 'Kept on this phone',
  awaazMicRefused: 'Microphone permission was refused — nothing recorded.',
  awaazDeviceFull: (waiting: number): string =>
    `Device full — ${waiting} note${s(waiting)} still waiting to send. ` +
    'Nothing has been deleted.',
  awaazCount: (n: number): string => `${n} awaaz note${s(n)}`,
  awaazNothingYet: 'No awaaz notes yet — hold the button and say it.',
  awaazRecordedAt: (when: string): string =>
    `Recorded ${when} — this phone’s clock`,
  awaazHoldAria: (target: string): string => `Record an awaaz note for ${target}`,

  // --------------------------------------------------------------- booking
  // The promise calendar (0022, phase 2): status stamps, the pencil
  // countdown, the overdue ladder's buttons, the refusals the write side
  // returns as data, and the WhatsApp confirmation the client receives
  // (demo/bookings.ts bookingConfirmText — golden-tested in both tables).
  bookingStatusDraft: 'Draft',
  bookingStatusConfirmed: 'Confirmed',
  bookingStatusCancelled: 'Cancelled',
  bookingStatusExpired: 'Pencil expired',
  bookingSeasonWedding: 'Wedding season',
  bookingPencilLeft: (hours: number, minutes: number): string =>
    `Pencil — ${hours}h ${minutes}m left`,
  bookingActionNudge: 'Send a WhatsApp nudge',
  bookingActionCall: 'Call the client',
  bookingActionLateFee: 'Draft the late fee',
  bookingActionManager: 'Escalate to the manager',
  bookingCollision: (code: string, no: number, name: string): string =>
    `${code} is already promised to booking #${no} (${name})`,
  bookingShort: (available: number, wanted: number, product: string): string =>
    `Only ${available} of ${wanted} × ${product} free for these dates`,
  bookingNeedsCredentials: (rupees: string): string =>
    `Needs credentials on file before a promise of ${rupees} — a manager can override with a note`,
  bookingBlacklisted: 'This customer is blacklisted — a booking cannot be confirmed',
  bookingAlreadyConfirmed: (no: number): string => `Booking #${no} is already confirmed`,
  bookingIsCancelled: (no: number): string => `Booking #${no} is cancelled`,
  bookingJobOpen: (no: number, label: string): string =>
    `Booking #${no} is out on job “${label}” — close the job first`,
  bookingConfirmTitle: (house: string): string => `${house} — booking confirmed`,
  bookingConfirmNo: (no: number): string => `Booking #${no}`,
  bookingConfirmFor: (name: string): string => `For: ${name}`,
  bookingConfirmWindow: (from: string, until: string): string =>
    `From ${from} to ${until}`,
  bookingConfirmItems: 'Items:',
  bookingConfirmLine: (qty: number, name: string): string => `${qty}x ${name}`,
  bookingConfirmNote: (note: string): string => `Note: ${note}`,
  bookingConfirmFooter: 'Reply here to change anything. Thank you.',

  // The desk: the kit-list reader at the top, then the calendar and the
  // bookings list under it.
  bookingDeskTitle: 'Desk',
  bookingDeskSubtitle: 'Kit lists, the calendar, the bookings',
  bookingKitListHeading: 'Kit list',
  bookingKitListSub: 'Paste what the client sent',
  bookingCalendarHeading: 'Calendar',
  bookingOpenCalendar: 'Open the calendar',
  bookingListHeading: 'Bookings',
  bookingListSub: (n: number): string => `${n} live booking${s(n)}`,
  bookingNoneYet: 'No bookings yet — pencil one in from a kit list or the calendar.',
  bookingNew: 'New booking',
  bookingItems: (n: number): string => `${n} item${s(n)}`,
  bookingRowNo: (no: number): string => `#${no}`,

  // The calendar page.
  bookingCalendarTitle: 'Calendar',
  bookingCalendarSubtitle: 'Confirmed holds, live pencils',
  bookingPrevMonthAria: 'Previous month',
  bookingNextMonthAria: 'Next month',
  bookingLegendConfirmed: 'confirmed',
  bookingLegendPencilled: 'pencilled',
  bookingDayHeading: (day: string): string => `On ${day}`,
  bookingNothingThatDay: 'Nothing promised that day.',
  bookingTapADay: 'Tap a day to see what is promised on it.',
  bookingMonthCounts: (confirmed: number, pencilled: number): string =>
    `${confirmed} confirmed · ${pencilled} pencilled`,

  // One booking's page.
  bookingTitle: (no: number): string => `Booking #${no}`,
  bookingNoSuchBooking: 'No such booking on this phone.',
  bookingBackToCalendar: 'Back to the calendar',
  bookingFromLabel: 'From',
  bookingUntilLabel: 'Until',
  bookingHeldUntil: (until: string): string => `Held for the fleet until ${until}`,
  bookingLinesHeading: 'What is promised',
  bookingLineQty: (qty: number, name: string): string => `${qty} × ${name}`,
  bookingLineAllocated: (codes: string): string => `Units: ${codes}`,
  bookingLineDemanded: (code: string): string => `This unit: ${code}`,
  bookingLineUnallocated: 'Units bound at confirm',
  bookingNoteHeading: 'Note',
  bookingCancelReason: (reason: string): string => `Reason: ${reason}`,
  bookingExpiredHint: 'This pencil expired — pencil it again if the client is still asking.',
  bookingOnJob: (label: string): string => `Out as job “${label}”`,
  bookingOpenJob: 'Open the job',
  bookingWaitingToSend: 'Waiting to send — the server will re-check this promise when the pipe drains.',
  bookingDoorConfirm: 'Confirm',
  bookingDoorExtend: 'Extend',
  bookingDoorConvert: 'Convert to job',
  bookingDoorSend: 'Send confirmation on WhatsApp',
  bookingDoorCancel: 'Cancel this booking',
  bookingCancelHint: 'Releases every unit. Hold to cancel — it cannot be un-cancelled.',
  bookingCancelReasonLabel: 'Why? (optional)',
  bookingCancelReasonPlaceholder: 'e.g. client postponed',
  bookingConvertNotConfirmed: 'Only a confirmed booking becomes a job',
  bookingConvertAlreadyJob: 'This booking is already a job',

  // The Confirm sheet: the three-layer answer per line, the allocation
  // preview, the buffer toggle, the credential gate.
  bookingConfirmSheetTitle: (no: number): string => `Confirm booking #${no}`,
  bookingConfirmSheetHint: 'Confirming binds units to this client. The server re-checks it when the pipe drains.',
  bookingLayerLine: (hereNow: number, pencilled: number, confirmed: number): string =>
    `${hereNow} here now · ${pencilled} pencilled · ${confirmed} confirmed for these dates`,
  bookingWillTake: (codes: string): string => `Will take ${codes}`,
  bookingWillHold: (qty: number): string => `Will hold ${qty} from stock`,
  bookingSameDayTurnaround: 'Same-day turnaround — no prep or turnaround buffer',
  bookingSameDayHint: 'The fleet is held for exactly the client’s dates. Use it when the next job leaves the same evening.',
  bookingHoldWindow: (from: string, until: string): string => `Held from ${from} until ${until}`,
  bookingOverrideNoteLabel: 'Manager’s note to override',
  bookingOverrideNotePlaceholder: 'e.g. known through Bilal, cheque held',
  bookingConfirmNow: 'Confirm — bind the units',
  bookingConfirmed: (no: number): string => `Booking #${no} confirmed`,
  bookingConfirmedWith: (codes: string): string => `Units bound: ${codes}`,
  bookingBlockedPeriodUncovers: 'The hold must cover the client’s whole window',
  bookingNotFound: 'That booking is not on this phone',

  // The New booking sheet.
  bookingNewTitle: 'New booking',
  bookingNewFromKitList: (n: number): string => `${n} line${s(n)} from the kit list`,
  bookingNewCustomerLabel: 'Whose booking?',
  bookingNewCustomerNeeded: 'A booking needs a customer — a promise has to be to someone.',
  bookingNewCustomerNameLabel: 'Customer name',
  bookingNewCustomerPhoneOptional: 'Phone (optional)',
  bookingNewStartLabel: 'Pickup',
  bookingNewEndLabel: 'Return',
  bookingNewLinesLabel: 'What they want',
  bookingNewAddLine: 'Add gear',
  bookingNewSearchGear: 'Search the catalogue',
  bookingNewNothingMatches: (q: string): string => `Nothing matches “${q}”`,
  bookingNewNoLines: 'Add at least one item.',
  bookingNewRemoveLineAria: (name: string): string => `Remove ${name}`,
  bookingNewMoreAria: (name: string): string => `One more ${name}`,
  bookingNewFewerAria: (name: string): string => `One fewer ${name}`,
  bookingNewKindLabel: 'Pencil or confirm?',
  bookingNewPencil: 'Pencil',
  bookingNewPencilHint: (hours: number): string =>
    `A pencil is a conversation — it holds nothing and dies after ${hours}h.`,
  bookingNewConfirm: 'Confirm now',
  bookingNewConfirmHint: 'Confirming binds units to this client today.',
  bookingNewNoteLabel: 'Note (optional)',
  bookingNewNotePlaceholder: 'e.g. mehndi + baraat, DHA',
  bookingNewCreate: 'Pencil it in',
  bookingNewCreateConfirmed: 'Book and confirm',
  bookingNewBadPeriod: 'The return must come after the pickup.',
  bookingNewPencilStands: (no: number): string =>
    `Pencil #${no} stands — fix the clash and confirm from its page.`,
  bookingNewConsumable: (name: string): string => `${name} is a consumable — it is sold, not booked`,
  bookingNewUnknownProduct: 'That product is not in the catalogue',
  bookingNewNoCustomer: 'That customer is not on this phone',

  // The extension screen — the one the research ranks highest.
  bookingExtendTitle: (no: number): string => `Extend booking #${no}`,
  bookingExtendHint: 'Pick the new return. The preview shows who is waiting on this gear before anything changes.',
  bookingExtendNewEndLabel: 'New return',
  bookingExtendClean: 'No one is waiting on this gear',
  bookingExtendNow: 'Extend',
  bookingExtendBlocked: (n: number): string =>
    `${n} client${s(n)} waiting on this gear — settle each card first`,
  bookingExtendEndsBeforeStart: 'The new return must come after the pickup.',
  bookingExtended: (no: number, until: string): string => `Booking #${no} now runs until ${until}`,
  bookingCollisionCard: (no: number, name: string, starts: string): string =>
    `promised to #${no} · ${name} · starts ${starts}`,
  bookingCollisionBulk: (shortBy: number, name: string): string => `${shortBy} × ${name} short`,
  bookingDoorSubRent: 'Sub-rent',
  bookingDoorSubstitute: 'Substitute',
  bookingDoorCall: 'Call',
  bookingCopyName: 'Copy the name',
  bookingSubRentNote: (product: string, qty: number, no: number): string =>
    `Sub-rent ${product} ×${qty} for #${no}`,
  bookingSubRentNoted: 'Sub-rent noted on the booking',
  bookingSubRentHint: 'Their claim on this unit stays until the partner’s unit is on the shelf; this extension will queue behind it.',
  bookingSubstituteTitle: (code: string, no: number): string => `Give #${no} another unit for ${code}`,
  bookingSubstituteHint: (name: string): string =>
    `Another ${name} only. Tapping a unit moves their claim onto it — their booking stays confirmed.`,
  bookingSubstituteNone: 'No free unit of this product for their dates — sub-rent, or call them.',
  bookingCardSettled: 'Settled',
  bookingCopied: 'Copied',

  // The Today board's Promised section and the overdue ladder.
  todayPromisedHeading: 'Promised',
  todayPromisedSub: 'Starting in the next two days, and pencils dying today',
  todayStartsAt: (when: string): string => `Starts ${when}`,
  // The ladder's rung in the house voice — the day, then what that day
  // asks for — never 'Step 1', which reads like a wizard. The action
  // arrives as data (core's EscalationAction), so a lookup with the
  // action itself as the fallback, like the ledger's KIND_EN.
  todayEscalationStep: (days: number, action: string): string =>
    `Day ${days} — ${ESCALATION_EN[action] ?? action}`,
  todayEscalated: (when: string): string => `With the manager since ${when}`,
  todayEscalateConsiderBlacklist: 'Day 14 — consider blacklisting when the manager reviews it',
  bookingManagerEscalationText: (job: string, days: number, items: string, customer: string | null): string =>
    [
      `OVERDUE — needs the manager`,
      `Job: ${job}${customer ? ` (${customer})` : ''}`,
      `${days} days late · ${items}`,
      `Nudged, called, late fee drafted. Please take it from here.`,
    ].join('\n'),

  // The scanner's promised-soon stamp, and the asset page's.
  bookingPromisedStamp: (no: number, day: string): string => `Promised · #${no} ${day}`,
  bookingPromisedRightNow: (no: number, name: string, when: string): string =>
    `Promised to booking #${no} (${name}) — hold begins ${when}`,

  // ----------------------------------------------------------------- quote
  // The quote (0024, phase 3): the challan the kit list becomes, the
  // trace in plain words, the override, the rate card and calendar
  // settings, and the WhatsApp quote the client receives (demo/quotes.ts
  // quoteTextOf — golden-tested in both tables).
  quoteSheetTitle: 'Quote',
  quoteSheetTitleFor: (no: number): string => `Quote — booking #${no}`,
  quoteStampIndicative: 'Indicative',
  quoteStampVerified: 'Verified — lighter deposit',
  quoteStampUnpriced: 'Unpriced — tell me the rate',
  quoteLineDays: (qty: number, days: number, rate: string): string =>
    `${qty} × ${days} day${s(days)} × ${rate}`,
  quoteLineOverridden: (reason: string): string => `Override: ${reason}`,
  quoteRateFieldLabel: (name: string): string => `Day rate for ${name}, rupees`,
  quoteRateFieldPlaceholder: 'e.g. 8000',
  quoteRateSave: 'Set the rate',
  quoteTotalLabel: 'Total',
  quoteTotalUnpriced: (n: number): string => `+${n} unpriced`,
  quoteSubHireLine: (cost: string, margin: string): string => `sub-hire ${cost} → margin ${margin}`,
  quoteHowHeading: 'How this was worked out',
  quoteStepDays: (calendarDays: number, first: string): string =>
    `${calendarDays} day${s(calendarDays)} from ${first} — 24 hours from pickup, back a minute late is the next day`,
  quoteStepWeekendDropped: (n: number, dates: string): string =>
    `${n} weekend day${s(n)} not billed: ${dates}`,
  quoteStepMinApplied: (min: number): string => `Below the ${min}-day minimum — billed as ${min}`,
  quoteStepWeekRule: (billable: number, counted: number, weeks: number, weekDays: number, remainder: number): string =>
    `${billable} billable day${s(billable)}: ${counted} days = ${weeks} week${s(weeks)} (${weeks * weekDays}) + ${remainder}`,
  // Under a week the arithmetic is noise ('2 days = 0 weeks (0) + 2'):
  // the trace just states the count.
  quoteStepWeekRuleShort: (billable: number): string => `${billable} billable day${s(billable)}`,
  quoteStepCardRates: (priced: number, unpriced: number, card: string): string =>
    `${priced} line${s(priced)} priced from the “${card}” card, ${unpriced} unpriced`,
  quoteStepNoCard: 'No rate card yet — every line is unpriced until one is set up under Settings → Rates',
  quoteStepMultiplier: (name: string, day: string, multiplier: string): string =>
    `${name} on ${day}: ${multiplier} on the whole booking`,
  quoteStepMultiplierNone: 'No holiday or season inside these dates',
  quoteStepOverrides: (n: number): string => `${n} line${s(n)} on an owner’s rate — the multiplier does not apply to those`,
  quoteIndicativeUnpriced: (n: number): string => `${n} item${s(n)} unpriced — the total is not the whole story`,
  quoteIndicativeNotConfirmed: 'Not confirmed yet — a quote, not a bill',
  quoteDoorSend: 'Send on WhatsApp',
  quoteDoorBook: 'Book it',
  quoteDoorPrice: 'Price it',
  quoteDoorSendQuote: 'Send quote',
  quoteOverrideDoor: 'Override a rate',
  quoteOverrideHint: 'Hold to override — the owner’s number replaces the card rate for this line, and the reason is kept.',
  quoteOverrideTitle: (name: string): string => `Owner’s rate for ${name}`,
  quoteOverrideRateLabel: 'Day rate, rupees',
  quoteOverrideReasonLabel: 'Why?',
  quoteOverrideReasonPlaceholder: 'e.g. long-standing client, agreed on the phone',
  quoteOverrideSave: 'Use this rate',
  quoteOverrideClear: 'Back to the card rate',
  quoteOverrideNeedsReason: 'An override needs a reason.',
  quoteCopied: 'Copied — paste it into WhatsApp',
  quoteNoLines: 'Nothing to price — resolve at least one line first.',
  quoteDepositHint: (hint: string): string =>
    hint === 'refuse' ? 'no booking — blacklisted'
    : hint === 'lighter' ? 'half deposit'
    : hint === 'standard' ? 'standard deposit'
    : 'full deposit — first booking',
  quoteDepositLabel: 'Deposit',

  // The Desk reply card: the date range and the Price it door.
  quoteWindowLabel: 'For these dates',
  quoteWindowStart: 'Pickup',
  quoteWindowEnd: 'Return',
  quoteWindowBad: 'The return must come after the pickup.',
  quoteReplyLine: (total: string, days: number): string =>
    `Quote: ${total} for ${days} billable day${s(days)}`,
  quoteReplyIndicative: (n: number): string =>
    `(indicative — ${n} item${s(n)} unpriced, final quote from the desk)`,

  // The booking page's Quote section and the Confirm sheet's honesty line.
  quoteSectionHeading: 'Quote',
  quoteSectionSub: (days: number): string => `${days} billable day${s(days)}`,
  quoteConfirmUnpriced: (n: number): string =>
    `${n} line${s(n)} unpriced — confirming is fine, the quote stays indicative until a rate is set`,

  // Settings → Rates.
  quoteRatesDoor: 'Rates and the calendar',
  quoteRatesDoorSub: 'The rate card, per-product day rates, holidays and seasons',
  quoteRatesTitle: 'Rates',
  quoteRatesSubtitle: 'The card, the day rates, the calendar',
  quoteCardHeading: 'The rate card',
  quoteCardSub: (name: string): string => `“${name}” — the default card`,
  quoteCardNone: 'No rate card yet. Set the knobs below to make one.',
  quoteCardWeekLabel: 'A week bills as (days)',
  quoteCardMinDaysLabel: 'Minimum billable days',
  quoteCardWeekendLabel: 'Days that do not bill',
  quoteCardWeekendHint: 'Every day bills unless a weekday is ticked here. A weekend-only job still bills the minimum.',
  quoteCardSave: 'Save the card',
  quoteCardSaved: 'Card saved — waiting to send',
  quoteRatesListHeading: 'Day rates',
  quoteRatesListSub: (priced: number, total: number): string => `${priced} of ${total} priced`,
  quoteRatesSearch: 'Search a product',
  quoteRateUnpriced: 'unpriced',
  quoteRateSetAria: (name: string): string => `Set the rate for ${name}`,
  quoteRatePerDay: (rate: string): string => `${rate}/day`,
  quoteCalendarHeading: 'Holidays and seasons',
  quoteCalendarSub: (holidays: number, seasonDays: number): string =>
    `${holidays} holiday${s(holidays)} · ${seasonDays} season day${s(seasonDays)}`,
  quoteCalendarAdd: 'Add a day',
  quoteCalendarDayLabel: 'Date',
  quoteCalendarKindLabel: 'Kind',
  quoteCalendarKindHoliday: 'Holiday',
  quoteCalendarKindSeason: 'Season',
  quoteCalendarNameLabel: 'Name',
  quoteCalendarNamePlaceholder: 'e.g. Eid ul-Fitr',
  quoteCalendarMultiplierLabel: 'Multiplier',
  quoteCalendarMultiplierHint: '1 = the same price, 1.25 = a quarter more. The highest day inside a booking sets its price.',
  quoteCalendarSave: 'Save the day',
  quoteCalendarRemoveAria: (name: string, day: string): string => `Remove ${name} on ${day}`,
  quoteCalendarSeasonRange: (name: string, from: string, until: string, n: number, multiplier: string): string =>
    `${name} · ${from} → ${until} · ${n} day${s(n)} · ${multiplier}`,
  quoteCalendarRow: (name: string, day: string, multiplier: string): string => `${name} · ${day} · ${multiplier}`,

  // The WhatsApp quote text (demo/quotes.ts quoteTextOf).
  quoteTextTitle: (house: string): string => `${house} — quote`,
  quoteTextFor: (name: string): string => `For: ${name}`,
  quoteTextWindow: (from: string, until: string): string => `From ${from} to ${until}`,
  quoteTextDays: (billable: number, calendarDays: number): string =>
    `${billable} billable day${s(billable)} (${calendarDays} on the calendar)`,
  quoteTextLine: (name: string, qty: number, days: number, rate: string, total: string): string =>
    `${name} × ${qty} · ${days} day${s(days)} · ${rate}/day = ${total}`,
  quoteTextLineUnpriced: (name: string, qty: number): string => `${name} × ${qty} · unpriced`,
  quoteTextMultiplier: (name: string, day: string, multiplier: string): string =>
    `${name} on ${day}: ${multiplier} on the whole booking`,
  quoteTextTotal: (rupees: string): string => `Total: ${rupees}`,
  quoteTextIndicativeUnpriced: (n: number): string =>
    `Indicative — ${n} item${s(n)} unpriced, final quote from the desk.`,
  quoteTextIndicativeNotConfirmed: 'Indicative — not confirmed yet.',
  quoteTextDeposit: (hint: string): string => `Deposit: ${hint}`,
  quoteTextPayment: (line: string): string => `Pay: ${line}`,
  quoteTextFooter: 'Reply here to confirm or change anything. Thank you.',

  // --------------------------------------------------------------- network
  // The partner network (0025 / Phase E): partner houses, ask the market,
  // sub-hire in and out, the crew line, the stolen broadcast, the thermal
  // parchi. One prefix, one block, so the merge with the concurrent
  // quoting wave is a paste.
  networkPartnersHeading: 'Partner houses',
  networkPartnersSub: 'The other houses you borrow from and lend to',
  networkPartnersNone: 'No partner houses yet — add the ones you call on a shaadi weekend.',
  networkAddPartner: 'Add a partner house',
  networkEditPartner: 'Edit',
  networkPartnerSheetTitle: 'Partner house',
  networkPartnerNameLabel: 'Name',
  networkPartnerPhoneLabel: 'Phone (optional)',
  networkPartnerCityLabel: 'City',
  networkPartnerNoteLabel: 'Note (optional)',
  networkPartnerNotePlaceholder: 'e.g. good for lenses, slow to pay',
  networkPartnerSave: 'Save partner',
  networkPartnerBlankName: 'A partner house needs a name.',
  networkPartnerDuplicate: 'A partner with that name is already on the list — one spelling per house.',
  networkPartnerNotFound: 'That partner house is not on this phone.',
  networkPartnerOpenLine: (inN: number, outN: number): string =>
    inN + outN === 0 ? 'Nothing open' : `${inN} borrowed · ${outN} lent`,
  networkPartnerRemove: 'Remove this partner house',
  networkPartnerRemoveHint: 'Refused while anything is still borrowed or lent. Hold to remove.',
  networkPartnerRemoveRefused: (n: number): string =>
    `${n} sub-hire${s(n)} still open with this partner — close them first.`,
  networkPartnerOpenKhata: 'Open their khata',
  networkPublicHeading: 'Public line',
  networkPublicSub: 'What the partner group sees on a broadcast',
  networkPublicPhoneLabel: 'Public phone (optional)',
  networkPublicPhonePlaceholder: 'e.g. 0300 1234567',
  networkPublicUrlLabel: 'Public tag page base (optional)',
  networkPublicUrlPlaceholder: 'e.g. https://tags.example.pk',
  networkPublicUrlHint: 'No page yet — the broadcast carries no link until one is set.',
  // The partner page.
  networkPartnerTitle: 'Partner house',
  networkPartnerCall: 'Call',
  networkPartnerWhatsApp: 'WhatsApp',
  networkPartnerNoSuch: 'No such partner house.',
  networkBackToPartners: 'Back to the partner houses',
  networkOpenHeading: 'Open',
  networkOpenSub: (n: number): string => `${n} sub-hire${s(n)} still open`,
  networkHistoryHeading: 'History',
  networkHistorySub: (n: number): string => `${n} closed sub-hire${s(n)}`,
  networkNothingOpen: 'Nothing borrowed or lent right now.',
  networkNothingYet: 'No history with this house yet.',
  networkMoneyHeading: 'Money',
  networkWeOwe: (amount: string, n: number): string => `We owe ${amount} across ${n} sub-hire${s(n)}`,
  networkWeOweNothing: 'Nothing owed to them on the kharcha book',
  networkTheyOwe: (amount: string): string => `They owe us ${amount}`,
  networkTheyOweNothing: 'Their khata is clear',
  networkTheyOweNoKhata: 'They have not borrowed from us yet',
  networkBorrowedStamp: 'borrowed',
  networkLentStamp: 'lent',
  networkSubHireStamp: 'sub-hire',
  networkRowIn: (qty: number, product: string, partner: string): string =>
    `${qty} × ${product} from ${partner}`,
  networkRowOut: (qty: number, product: string, partner: string): string =>
    `${qty} × ${product} to ${partner}`,
  networkRowUnit: (code: string): string => `Unit ${code}`,
  networkRowWindow: (from: string, until: string): string => `${from} → ${until}`,
  networkRowUnpriced: 'unpriced',
  networkRowReturned: (when: string): string => `Closed ${when}`,
  networkCameBack: 'Came back',
  networkReturned: 'Returned to them',
  networkCloseRefusedUnitOut: 'The borrowed unit is still out on a job — scan it in first.',
  networkCloseRefusedJobOut: (n: number): string =>
    `${n} item${s(n)} still out on the sub-hire job — scan them in first.`,
  networkCloseRefusedFuture: 'A return is a past fact — it cannot be in the future.',
  networkCloseRefusedBeforeStart: 'That is before the sub-hire began.',
  networkCloseRefusedClosed: 'Already closed.',
  networkCloseRefusedNotFound: 'That sub-hire is not on this phone.',
  // Ask the market.
  networkAskMarket: 'Ask the market',
  networkAskMarketHint: 'One message to the partner houses. Tick who to ask, then send it to each — the send stays yours.',
  networkAskMarketShortage: 'Short',
  networkAskMarketNoPartners: 'No partner houses to ask — add them in Settings.',
  networkAskMarketPreview: 'The message',
  networkAskMarketSendTo: (name: string): string => `Send to ${name}`,
  networkAskMarketSent: 'Sent',
  networkAskMarketNoNumber: 'no number',
  networkAskMarketCopy: 'Copy the message',
  networkAskMarketCopied: 'Copied',
  networkAskMarketTheySaidYes: 'They said yes — record the sub-hire',
  networkAskMarketWindowLabel: 'Dates',
  // Sub-hire in.
  networkSubHireInTitle: 'Record a sub-hire in',
  networkSubHireInHint: 'Gear borrowed from a partner. With a serial the unit joins the fleet as borrowed and can take a label.',
  networkSubHireFromLabel: 'From',
  networkSubHireProductLabel: 'What',
  networkSubHireProductSearch: 'Search the catalogue',
  networkSubHireProductSearchAria: 'Find a product',
  networkSubHireUnitLabel: 'Which unit',
  networkSubHireAnyUnit: (n: number, product: string): string => `${n} × ${product}, whichever is free`,
  networkSubHireQtyLabel: 'How many',
  networkSubHireStartLabel: 'From',
  networkSubHireEndLabel: 'Until',
  networkSubHireSerialLabel: 'Serial (optional)',
  networkSubHireSerialHint: 'Given, the unit is created as borrowed — tag it, scan it, count it like your own.',
  networkSubHireCostLabel: 'Agreed cost (Rs, optional)',
  networkSubHireCostHint: 'Blank means unpriced — counted, never zero. Settle it later on the kharcha book.',
  networkSubHireChargeLabel: 'Agreed charge (Rs, optional)',
  networkSubHireChargeHint: 'Blank means unpriced. A number goes straight on their khata.',
  networkSubHireNoteLabel: 'Note (optional)',
  networkSubHireRecord: 'Record the sub-hire',
  networkSubHireInDone: (code: string, partner: string): string =>
    `${code} is on the shelf, borrowed from ${partner}.`,
  networkSubHireInDoneNoUnit: (partner: string): string => `Recorded — borrowed from ${partner}.`,
  networkSubHireAttachLabel: 'Attach a label',
  networkSubHireRefusal: (reason: string): string =>
    ({
      no_partner: 'Pick a partner house.',
      no_product: 'Pick a product.',
      no_asset: 'That unit is not on this phone.',
      bad_period: 'The return must come after the pickup.',
      bad_qty: 'At least one unit.',
      bad_cost: 'An agreed cost is a positive number, or left blank.',
      bad_charge: 'An agreed charge is a positive number, or left blank.',
      serial_needs_one: 'A serial names one unit — set the count to 1.',
      not_serialized: 'That product is counted, not serialised — leave the serial blank.',
      serial_in_fleet: 'That serial is already in the fleet.',
      asset_gone: 'That unit has left the fleet.',
      asset_borrowed: 'That unit is itself borrowed — it cannot be lent on.',
      asset_needs_one: 'A named unit is one unit.',
      no_customer: 'Could not open a khata for this partner.',
    }[reason] ?? reason),
  // Lend out.
  networkLendTitle: 'Lend to a partner',
  networkLendHint: 'A job named for the partner appears on the board; scan the gear out onto it like any client’s.',
  networkLendPartnerLabel: 'To',
  networkLendRecord: 'Lend it',
  networkLendThisUnit: 'Lend to a partner',
  networkBorrowedFrom: (partner: string): string => `Borrowed from ${partner}`,
  networkBorrowedOpenPartner: 'Open the partner house',
  // Crew.
  networkCrewWith: 'With',
  networkCrewAdd: 'Add crew',
  networkCrewPickTitle: 'Who is going with it?',
  networkCrewPickHint: 'Tap a name to put them on the truck. Hold a chip on the card to take them off.',
  networkCrewRoleAttendant: 'attendant',
  networkCrewRoleDriver: 'driver',
  networkCrewRemoveAria: (name: string): string => `Hold to take ${name} off the crew`,
  networkCrewNobodyLeft: 'Everyone is already on it.',
  // The stolen broadcast.
  networkTellPartners: 'Tell the partner houses',
  networkTellPartnersHint: 'The short line for the partner group, sent to each house. The public page rides along when one is set.',
  networkTellPartnersNoPage: 'No public page yet — the line carries no link.',
  // The thermal parchi.
  networkThermalPrint: 'Thermal print',
  networkThermalNoPrinter: 'No printer connected — the bytes are built, the Bluetooth link is the Android build.',
  networkThermalSaved: 'Printer bytes saved (dev only).',
  networkThermalFailed: (reason: string): string => `Print failed: ${reason}`,
  networkThermalSent: 'Sent to the printer.',
}

/**
 * The shape every language table must satisfy: the English table's keys and
 * signatures, with the strings widened. strings-ur.ts annotates with this, so
 * dropping a key, adding a stray one, or changing a function's arity is a
 * compile error in the translation file, not a runtime surprise.
 */
export type StrTable = typeof STR_EN

/**
 * The active table, picked once per boot. setLang() (lang.ts) reloads the
 * page, which re-runs this module — there is deliberately no live rebinding.
 */
export const STR: StrTable = getLang() === 'ur' ? STR_UR : STR_EN

/** The English table by name, for tests that compare tables. */
export { STR_EN }
