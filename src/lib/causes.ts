// Labels for the cause tags the kill feed sends (`Id.Item.AK74M`, `Vehicle.Variant.Air.Rotary.
// Littlebird.Default`, ...). The game sends no display names, so the tags it is known to send are
// listed here, by name where one is known and in their own words where not (a rule offers only the
// tags listed), and anything else falls back to a readable form of its last segments. A tag is
// looked up in any case: the game writes `ID.Item.` for some items and `Id.Item.` for others.
// Client-safe.

export type CauseKind = 'weapon' | 'vehicle weapon' | 'vehicle' | 'buildable' | 'none';

const LABELS: Record<string, string> = {
	// Firearms and launchers, as the game's weapon list names them. Vector, RFB and LMG_02 by
	// calibre and class: the only .45 SMG, the only semi-automatic .308, the other LMG.
	'Id.Item.A91': 'A-91',
	'Id.Item.KH2002': 'KH-2002',
	'Id.Item.TAR21': 'T-21',
	'Id.Item.AK74M': 'AK74',
	'Id.Item.WEPN_029': 'Galil',
	'Id.Item.M4': 'M4',
	'Id.Item.MP9': 'AMP-9',
	'Id.Item.Vector': 'Super-45',
	'Id.Item.MP43': 'MP43',
	'Id.Item.M500': 'M500',
	'Id.Item.M249': 'M249 SAW',
	'Id.Item.LMG_02': 'PKM',
	'Id.Item.SKS': 'SKS',
	'Id.Item.SVDM': 'SVD',
	'Id.Item.RFB': 'BMR-308',
	'Id.Item.Mosin': 'Mosin Nagant',
	'Id.Item.SV98': 'SV98',
	'Id.Item.MK22': 'MK22',
	'Id.Item.CombatBow': 'Compound bow',
	'Id.Item.Glock17': 'GGX 17',
	'Id.Item.Judge': 'Judge',
	'Id.Item.RPG7': 'RPG-7',
	'Id.Item.CGM4': 'MAAWS',
	'Id.Item.MMGL': 'MGL-40',
	// From a list shared among server admins, each in the class its kill distances put it in:
	// three pistols, two SMGs, a bullpup with the KH-2002 and A-91, a rifle, a scout rifle, the
	// longest-range rifle, and Launcher_04's kills nearly all vehicle explosions at a few hundred
	// metres. Within a class (which pistol is which) the distances cannot tell.
	'Id.Item.WEPN_026': 'M1911',
	'Id.Item.WEPN_027': 'Deagle',
	'Id.Item.WEPN_032': 'GGX 18',
	'Id.Item.WEPN_028': 'MP5',
	'Id.Item.SMG_03': 'PP-19 Vityaz',
	'Id.Item.WEPN_033': 'Bushmaster M17S',
	'Id.Item.WEPN_030': 'FAL',
	'Id.Item.WEPN_035': 'Scout Rifle TD',
	'Id.Item.SR_04': 'AMR 50',
	'Id.Item.Launcher_04': '9K333 Verba',
	// Explosives and tools
	'Id.Item.M67Grenade': 'M67 frag grenade',
	'Id.Item.C4Explosive': 'C4 charge',
	'Id.Item.IED.Explosive': 'IED',
	'Id.Item.ATMine': 'AT mine',
	'Id.Item.Claymore': 'Claymore',
	'Id.Item.Crowbar': 'Halligan bar',
	'Id.Item.Fists': 'Fists',
	'Id.Item.Defibrillator.Standard': 'Defibrillator',
	'ID.Item.BuildTool.Hammer.Large': 'Large hammer',
	'ID.Item.BuildTool.Hammer.Medium': 'Medium hammer',
	'ID.Item.BuildTool.Hammer.Small': 'Small hammer',
	'ID.Item.RepairTool.Drill.Light': 'Light drill',
	'ID.Item.RepairTool.Drill.Heavy': 'Heavy drill',
	'ID.Item.SmokeGrenade.White': 'White smoke grenade',
	'Id.Item.VehicleSupplyCrate.Pallet.MunitionsSupply': 'Ammo supply pallet',
	// Buildables
	'Id.Buildable.BremmerWall': 'Bremer wall',
	'Id.Buildable.BarbedWire': 'Barbed wire',
	'Id.Buildable.HBlock': 'H-block',
	'Id.Buildable.TallHBlock': 'Tall H-block',
	// Vehicles: the crew's guns or a roadkill
	'Vehicle.Variant.Air.Rotary.Littlebird.Default': 'MH-6',
	'Vehicle.Variant.Air.Rotary.Littlebird.MountedMachineGuns': 'AH-6M',
	'Vehicle.Variant.Air.Rotary.Littlebird.RocketPods': 'AH-6R',
	'Vehicle.Variant.Air.Rotary.Havoc.Default': 'Havoc',
	'Vehicle.Variant.Air.Rotary.ROT_04.Default': 'Z20 Lakota',
	'Vehicle.Variant.Air.Rotary.ROT_04.MountedMachineGuns': 'Z20 Lakota (miniguns)',
	'Vehicle.Variant.Land.Tracked.TNK_01.AntiAir': 'Flakpanzer Gepard',
	'Vehicle.Variant.Land.Tracked.TNK_01.Heavy': 'L2A6',
	'Vehicle.Variant.Land.Tracked.TNK_01.Artillery': 'SPH-2',
	'Vehicle.Variant.Land.Tracked.SpawnVehicle.Lonestar': 'M113 APC',
	'Vehicle.Variant.Land.Tracked.SpawnVehicle.Valkyra': 'M113 APC',
	'Vehicle.Variant.Land.Tracked.SpawnVehicle.Manticore': 'M113 APC',
	'Vehicle.Variant.Land.Wheeled.Humvee.Default': 'Humvee',
	'Vehicle.Variant.Land.Wheeled.Humvee.MachineGun': 'Humvee (M249)',
	'Vehicle.Variant.Land.Wheeled.Humvee.Minigun': 'Humvee (minigun)',
	'Vehicle.Variant.Land.Wheeled.Kodiak.Default': 'Kodiak',
	'Vehicle.Variant.Land.Wheeled.Kodiak.MachineGun': 'Kodiak (M249)',
	'Vehicle.Variant.Land.Wheeled.Kodiak.Pickup': 'Kodiak (pickup)',
	'Vehicle.Variant.Land.Wheeled.Ural.Default': 'Ural',
	'Vehicle.Variant.Land.Wheeled.Ural.Battle': 'Ural Defender',
	'Vehicle.Variant.Land.Wheeled.Ural.Attack': 'Ural Defender (M249)',
	'Vehicle.Variant.Land.Wheeled.Bobcat.Default': 'Bobcat',
	'Vehicle.Variant.Land.Wheeled.DuneBuggy.Default': 'Dune buggy',
	'Vehicle.Variant.Stationary.Phalanx': 'Vanguard CIWS',
	'Vehicle.Variant.Stationary.Mortar': 'L81 mortar',
	'Vehicle.Variant.Stationary.MistralAA': 'Talon 9K-SAM',
	'Vehicle.Variant.Stationary.STN_05': 'STN 05',
	'Vehicle.Variant.Stationary.Loudspeaker': 'Loudspeaker',
	// Vehicle weapons
	'Id.Vehicle.WeaponExtension.ROT_02.30mmCannon': 'Havoc 2A42 autocannon',
	'Id.Vehicle.WeaponExtension.ROT_02.122mm': 'Havoc B-13 rockets',
	'Id.Vehicle.WeaponExtension.ROT_03.MountedMachineGun': 'AH-6M miniguns',
	'Id.Vehicle.WeaponExtension.ROT_03.RocketPods': 'AH-6R rockets',
	'Id.Vehicle.WeaponExtension.ROT_04.MountedMachineGun': 'Z20 Lakota miniguns',
	'Id.Vehicle.WeaponExtension.TNK_01.Artillery': 'SPH-2 artillery',
	'Id.Vehicle.WeaponExtension.TNK_01.Heavy': 'L2A6 cannon',
	'Id.Vehicle.WeaponExtension.TNK_01.MachineGun': 'L2A6 machine gun',
	'Id.Vehicle.WeaponExtension.TNK_01.MountedMachineGun': 'L2A6 mounted MG',
	'Id.Vehicle.WeaponExtension.WHL_02.SUV.RingTurret': 'Kodiak M249',
	'Id.Vehicle.WeaponExtension.WHL_05.RingTurret': 'Humvee M249',
	'Id.Vehicle.WeaponExtension.WHL_05.RingMinigun': 'Humvee minigun',
	'Id.Vehicle.WeaponExtension.WHL_07.MachineGun': 'Ural Defender M249',
	'Id.Vehicle.WeaponExtension.STN_01.MistralAA': 'Talon 9K-SAM',
	'Id.Vehicle.WeaponExtension.STN_02.MainCannon': 'STN 02 main cannon',
	'Id.Vehicle.WeaponExtension.STN_03.MainBarrel': 'STN 03 main gun',
	'Id.Vehicle.WeaponExtension.STN_05.MainBarrel': 'STN 05 main gun'
};
/**
 * What a Team kill limit leaves out of its count unless its settings say otherwise: a player who
 * runs into a teammate's barbed wire is reported as killed by whoever built it.
 */
export const TEAM_KILL_NOT_COUNTED: readonly string[] = ['Id.Buildable.BarbedWire'];

/** The table by lower-case tag, for a lookup in any case. */
const BY_TAG = new Map(
	Object.entries(LABELS).map(([cause, label]) => [cause.toLowerCase(), label])
);

/** What sort of thing the cause is, from its prefix. */
export function causeKind(cause: string | null | undefined): CauseKind {
	if (!cause) return 'none';
	if (/^Id\.Vehicle\.WeaponExtension\./i.test(cause)) return 'vehicle weapon';
	if (/^Vehicle\./i.test(cause)) return 'vehicle';
	if (/^Id\.Buildable\./i.test(cause)) return 'buildable';
	return 'weapon';
}

/** `WEPN_035` → `WEPN 035`, `MountedMachineGuns` → `Mounted machine guns`: a codename keeps its capitals. */
function pretty(segment: string): string {
	const words = segment
		.replace(/_/g, ' ')
		.replace(/([a-z])([A-Z])/g, '$1 $2')
		.replace(/([A-Za-z])(\d)/g, '$1 $2')
		.trim()
		.split(/\s+/);
	return words
		.map((w, i) => {
			if (/^[A-Z0-9]+$/.test(w) && /[A-Z]{2}/.test(w)) return w;
			const lower = w.toLowerCase();
			return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
		})
		.join(' ');
}

/** Every cause named above, for a filter's choices: label first so a list reads alphabetically. */
export function knownCauses(): { cause: string; label: string }[] {
	return Object.entries(LABELS)
		.map(([cause, label]) => ({ cause, label }))
		.sort((a, b) => a.label.localeCompare(b.label));
}

/** A display name for the tag: the known ones by name, the rest from their meaningful segments. */
export function causeLabel(cause: string | null | undefined): string {
	if (!cause) return '';
	const known = BY_TAG.get(cause.toLowerCase());
	if (known) return known;
	const segs = cause.split('.').filter(Boolean);
	switch (causeKind(cause)) {
		case 'vehicle': {
			// Vehicle.Variant.Air.Rotary.Littlebird.Default: the model, plus the variant unless Default.
			const [model, variant] = segs.slice(4);
			return variant && variant !== 'Default'
				? `${pretty(model ?? '')} (${pretty(variant).toLowerCase()})`
				: pretty(model ?? segs[segs.length - 1]);
		}
		case 'vehicle weapon':
			// Id.Vehicle.WeaponExtension.STN_03.MainBarrel: the mount and the weapon.
			return segs.slice(3).map(pretty).join(' ');
		case 'buildable':
			return pretty(segs[segs.length - 1]);
		default:
			// Id.Item.Mosin, Id.Item.Defibrillator.Standard
			return segs.slice(2).map(pretty).join(' ');
	}
}
