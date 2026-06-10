const municipalMapping: Record<string, string> = {
    // Columbia (C)
    C06: 'Hudson (C06)', C20: 'Ancram (C20)', C22: 'Austerlitz (C22)', C24: 'Canaan (C24)', C26: 'Chatham (C26)', C28: 'Claverack (C28)', C30: 'Clermont (C30)', C32: 'Copake (C32)', C34: 'Gallatin (C34)', C36: 'Germantown (C36)', C38: 'Ghent (C38)', C40: 'Greenport (C40)', C42: 'Hillsdale (C42)', C44: 'Kinderhook (C44)', C46: 'Livingston (C46)', C48: 'New Lebanon (C48)', C50: 'Stockport (C50)', C52: 'Stuyvesant (C52)', C54: 'Taghkanic (C54)',
    // Delaware (L)
    L20: 'Andes (L20)', L22: 'Bovina (L22)', L24: 'Colchester (L24)', L26: 'Davenport (L26)', L28: 'Delhi (L28)', L30: 'Deposit (L30)', L32: 'Franklin (L32)', L34: 'Hamden (L34)', L36: 'Hancock (L36)', L38: 'Harpersfield (L38)', L40: 'Kortright (L40)', L42: 'Masonville (L42)', L44: 'Meredith (L44)', L46: 'Middletown (L46)', L48: 'Roxbury (L48)', L50: 'Sidney (L50)', L52: 'Stamford (L52)', L54: 'Tompkins (L54)', L56: 'Walton (L56)',
    // Dutchess (D)
    D02: 'Beacon (D02)', D13: 'Poughkeepsie (city) (D13)', D20: 'Amenia (D20)', D22: 'Beekman (D22)', D24: 'Clinton (D24)', D26: 'Dover (D26)', D28: 'East Fishkill (D28)', D30: 'Fishkill (D30)', D32: 'Hyde Park (D32)', D34: 'La Grange (D34)', D36: 'Milan (D36)', D38: 'Northeast (D38)', D40: 'Pawling (D40)', D42: 'Pine Plains (D42)', D44: 'Pleasant Valley (D44)', D46: 'Poughkeepsie (D46)', D48: 'Red Hook (D48)', D50: 'Rhinebeck (D50)', D52: 'Stanford (D52)', D54: 'Union Vale (D54)', D56: 'Wappinger (D56)', D58: 'Washington (D58)',
    // Greene (G)
    G20: 'Ashland (G20)', G22: 'Athens (G22)', G24: 'Cairo (G24)', G26: 'Catskill (G26)', G28: 'Coxsackie (G28)', G30: 'Durham (G30)', G32: 'Greenville (G32)', G34: 'Halcott (G34)', G36: 'Hunter (G36)', G38: 'Jewett (G38)', G40: 'Lexington (G40)', G42: 'New Baltimore (G42)', G44: 'Prattsville (G44)', G46: 'Windham (G46)',
    // Nassau (N)
    N05: 'Glen Cove City (N05)', N06: 'Glen Cove (N06)', N09: 'Long Beach City (N09)', N10: 'Long Beach (N10)', N20: 'Hempstead (N20)', N22: 'North Hempstead (N22)', N24: 'Oyster Bay (N24)',
    // Orange (O)
    O09: 'Middletown (O09)', O11: 'Newburgh (City) (O11)', O13: 'Port Jervis (O13)', O20: 'Blooming Grove (O20)', O22: 'Chester (O22)', O24: 'Cornwall (O24)', O26: 'Crawford (O26)', O28: 'Deerpark (O28)', O30: 'Goshen (O30)', O32: 'Greenville (O32)', O34: 'Hamptonburgh (O34)', O36: 'Highlands (O36)', O38: 'Minisink (O38)', O40: 'Monroe (O40)', O42: 'Montgomery (O42)', O44: 'Mount Hope (O44)', O46: 'Newburgh (O46)', O48: 'New Windsor (O48)', O50: 'Tuxedo (O50)', O52: 'Wallkill (O52)', O54: 'Warwick (O54)', O56: 'Wawayanda (O56)', O58: 'Woodbury (O58)', O60: 'Palm Tree (O60)',
    // Putnam (P)
    P20: 'Carmel (P20)', P22: 'Kent (P22)', P24: 'Patterson (P24)', P26: 'Philipstown (P26)', P28: 'Putnam Valley (P28)', P30: 'Southeast (P30)',
    // Rockland (R)
    R20: 'Clarkstown (R20)', R22: 'Haverstraw (R22)', R24: 'Orangetown (R24)', R26: 'Ramapo (R26)', R28: 'Stony Point (R28)',
    // Suffolk (S)
    S01: 'Babylon (S01)', S02: 'Brookhaven (S02)', S03: 'East Hampton (S03)', S04: 'Huntington (S04)', S05: 'Islip (S05)', S06: 'Riverhead (S06)', S07: 'Shelter Island (S07)', S08: 'Smithtown (S08)', S09: 'Southampton (S09)', S10: 'Southold (S10)',
    // Sullivan (V)
    V20: 'Bethel (V20)', V22: 'Callicoon (V22)', V24: 'Cochecton (V24)', V26: 'Delaware (V26)', V28: 'Fallsburgh (V28)', V30: 'Forestburgh (V30)', V32: 'Fremont (V32)', V34: 'Highland (V34)', V36: 'Liberty (V36)', V38: 'Lumberland (V38)', V40: 'Mamakating (V40)', V42: 'Neversink (V42)', V44: 'Rockland (V44)', V46: 'Thompson (V46)', V48: 'Tusten (V48)',
    // Ulster (U)
    U08: 'Kingston (city) (U08)', U20: 'Denning (U20)', U22: 'Esopus (U22)', U24: 'Gardiner (U24)', U26: 'Hardenburgh (U26)', U28: 'Hurley (U28)', U30: 'Kingston (U30)', U32: 'Lloyd (U32)', U34: 'Marbletown (U34)', U36: 'Marlborough (U36)', U38: 'New Paltz (U38)', U40: 'Olive (U40)', U42: 'Plattekill (U42)', U44: 'Rochester (U44)', U46: 'Rosendale (U46)', U48: 'Saugerties (U48)', U50: 'Shandaken (U50)', U52: 'Shawangunk (U52)', U54: 'Ulster (U54)', U56: 'Wawarsing (U56)', U58: 'Woodstock (U58)',
    // Westchester (W)
    W08: 'Mt Vernon (W08)', W10: 'New Rochelle (W10)', W12: 'Peekskill (W12)', W14: 'Rye City (W14)', W17: 'White Plains (W17)', W18: 'Yonkers (W18)', W20: 'Bedford (W20)', W22: 'Cortlandt (W22)', W24: 'Eastchester (W24)', W26: 'Greenburgh (W26)', W28: 'Harrison (W28)', W30: 'Lewisboro (W30)', W32: 'Mamaroneck (W32)', W34: 'Mount Pleasant (W34)', W36: 'New Castle (W36)', W38: 'North Castle (W38)', W40: 'North Salem (W40)', W42: 'Ossining (W42)', W44: 'Pelham (W44)', W46: 'Pound Ridge (W46)', W48: 'Rye (W48)', W50: 'Scarsdale (W50)', W52: 'Somers (W52)', W54: 'Yorktown (W54)', W56: 'Mount Kisco (W56)',
};

export function getMunicipalityName(code: string): string {
    return municipalMapping[code] ?? code;
}
