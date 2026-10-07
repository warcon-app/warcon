import { describe, expect, test } from 'bun:test';
import { causeKind, causeLabel, knownCauses } from './causes';

describe('causeLabel', () => {
	test('named weapons, tools, buildables and vehicles', () => {
		expect(causeLabel('Id.Item.AK74M')).toBe('AK74');
		expect(causeLabel('Id.Item.TAR21')).toBe('T-21');
		expect(causeLabel('Id.Item.Glock17')).toBe('GGX 17');
		expect(causeLabel('Id.Item.CombatBow')).toBe('Compound bow');
		expect(causeLabel('Id.Item.Mosin')).toBe('Mosin Nagant');
		expect(causeLabel('Id.Item.M249')).toBe('M249 SAW');
		expect(causeLabel('Id.Item.Vector')).toBe('Super-45');
		expect(causeLabel('Id.Item.WEPN_029')).toBe('Galil');
		expect(causeLabel('Id.Item.MMGL')).toBe('MGL-40');
		expect(causeLabel('Id.Item.CGM4')).toBe('MAAWS');
		expect(causeLabel('Id.Item.M4')).toBe('M4');
		expect(causeLabel('Id.Item.M67Grenade')).toBe('M67 frag grenade');
		expect(causeLabel('Id.Item.Crowbar')).toBe('Halligan bar');
		expect(causeLabel('ID.Item.BuildTool.Hammer.Large')).toBe('Large hammer');
		expect(causeLabel('Id.Buildable.TallHBlock')).toBe('Tall H-block');
		expect(causeLabel('Vehicle.Variant.Air.Rotary.Littlebird.Default')).toBe('MH-6');
		expect(causeLabel('Vehicle.Variant.Land.Tracked.SpawnVehicle.Lonestar')).toBe('M113 APC');
		expect(causeLabel('Vehicle.Variant.Stationary.Phalanx')).toBe('Vanguard CIWS');
		expect(causeLabel('Id.Vehicle.WeaponExtension.WHL_02.SUV.RingTurret')).toBe('Kodiak M249');
		expect(causeLabel('Id.Vehicle.WeaponExtension.ROT_02.30mmCannon')).toBe(
			'Havoc 2A42 autocannon'
		);
	});

	test("a named tag in the game's other casing keeps its name", () => {
		expect(causeLabel('ID.Item.M67Grenade')).toBe('M67 frag grenade');
		expect(causeLabel('Id.Item.BuildTool.Hammer.Small')).toBe('Small hammer');
		expect(causeLabel('ID.Item.Fists')).toBe('Fists');
		expect(causeLabel('ID.Vehicle.WeaponExtension.STN_01.MistralAA')).toBe('Talon 9K-SAM');
	});

	test('the codenamed firearms and launcher have their names', () => {
		expect(causeLabel('Id.Item.WEPN_026')).toBe('M1911');
		expect(causeLabel('Id.Item.WEPN_027')).toBe('Deagle');
		expect(causeLabel('Id.Item.WEPN_028')).toBe('MP5');
		expect(causeLabel('Id.Item.WEPN_030')).toBe('FAL');
		expect(causeLabel('Id.Item.WEPN_032')).toBe('GGX 18');
		expect(causeLabel('Id.Item.WEPN_033')).toBe('Bushmaster M17S');
		expect(causeLabel('Id.Item.WEPN_035')).toBe('Scout Rifle TD');
		expect(causeLabel('Id.Item.SMG_03')).toBe('PP-19 Vityaz');
		expect(causeLabel('Id.Item.SR_04')).toBe('AMR 50');
		expect(causeLabel('Id.Item.Launcher_04')).toBe('9K333 Verba');
	});

	test('tags the game sends that have no name are listed in their own words', () => {
		expect(causeLabel('ID.Item.RepairTool.Drill.Light')).toBe('Light drill');
		expect(causeLabel('Vehicle.Variant.Land.Wheeled.Humvee.Default')).toBe('Humvee');
		expect(causeLabel('Id.Vehicle.WeaponExtension.STN_05.MainBarrel')).toBe('STN 05 main gun');
		const listed = new Set(knownCauses().map((c) => c.cause.toLowerCase()));
		for (const tag of ['Id.Item.MMGL', 'Id.Item.Mosin', 'Vehicle.Variant.Stationary.STN_05'])
			expect([tag, listed.has(tag.toLowerCase())]).toEqual([tag, true]);
	});

	test('unnamed tags read from their segments', () => {
		expect(causeLabel('Id.Item.Makarov')).toBe('Makarov');
		expect(causeLabel('Id.Item.WEPN_099')).toBe('WEPN 099');
		expect(causeLabel('Id.Item.SMG_09')).toBe('SMG 09');
		expect(causeLabel('Vehicle.Variant.Land.Wheeled.Jeep.Default')).toBe('Jeep');
		expect(causeLabel('Vehicle.Variant.Land.Wheeled.Ural.Transport')).toBe('Ural (transport)');
		expect(causeLabel('Vehicle.Variant.Air.Rotary.ROT_05.Default')).toBe('ROT 05');
		expect(causeLabel('Id.Vehicle.WeaponExtension.STN_09.Turret')).toBe('STN 09 Turret');
		expect(causeLabel('Id.Buildable.Gate')).toBe('Gate');
		expect(causeLabel('Id.Vehicle.WeaponExtension.WHL_09.RingTurret')).toBe('WHL 09 Ring turret');
	});

	test('the named causes as filter choices, alphabetical by label', () => {
		const list = knownCauses();
		expect(list.find((c) => c.cause === 'Id.Item.WEPN_029')?.label).toBe('Galil');
		expect(list.map((c) => c.label)).toEqual(
			[...list.map((c) => c.label)].sort((a, b) => a.localeCompare(b))
		);
	});

	test('nothing for no cause', () => {
		expect(causeLabel(null)).toBe('');
		expect(causeLabel('')).toBe('');
	});
});

describe('causeKind', () => {
	test('by prefix', () => {
		expect(causeKind('Id.Item.AK74M')).toBe('weapon');
		expect(causeKind('ID.Item.BuildTool.Hammer.Large')).toBe('weapon');
		expect(causeKind('Id.Vehicle.WeaponExtension.STN_03.MainBarrel')).toBe('vehicle weapon');
		expect(causeKind('Vehicle.Variant.Air.Rotary.Littlebird.Default')).toBe('vehicle');
		expect(causeKind('Id.Buildable.Gate')).toBe('buildable');
		expect(causeKind(null)).toBe('none');
	});
});
