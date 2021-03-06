import {decode_identity, IdentitifyType, Identity} from "tc-shared/profiles/Identity";
import {guid} from "tc-shared/crypto/uid";
import {TeaForumIdentity} from "tc-shared/profiles/identities/TeaForumIdentity";
import {TeaSpeakIdentity} from "tc-shared/profiles/identities/TeamSpeakIdentity";
import {AbstractServerConnection} from "tc-shared/connection/ConnectionBase";
import {HandshakeIdentityHandler} from "tc-shared/connection/HandshakeHandler";
import {createErrorModal} from "tc-shared/ui/elements/Modal";
import {formatMessage} from "tc-shared/ui/frames/chat";

export class ConnectionProfile {
    id: string;

    profile_name: string;
    default_username: string;
    default_password: string;

    selected_identity_type: string = "unset";
    identities: { [key: string]: Identity } = {};

    constructor(id: string) {
        this.id = id;
    }

    connect_username(): string {
        if (this.default_username && this.default_username !== "Another TeaSpeak user")
            return this.default_username;

        let selected = this.selected_identity();
        let name = selected ? selected.fallback_name() : undefined;
        return name || "Another TeaSpeak user";
    }

    selected_identity(current_type?: IdentitifyType): Identity {
        if (!current_type)
            current_type = this.selected_type();

        if (current_type === undefined)
            return undefined;

        if (current_type == IdentitifyType.TEAFORO) {
            return TeaForumIdentity.identity();
        } else if (current_type == IdentitifyType.TEAMSPEAK || current_type == IdentitifyType.NICKNAME) {
            return this.identities[IdentitifyType[current_type].toLowerCase()];
        }

        return undefined;
    }

    selected_type?(): IdentitifyType {
        return this.selected_identity_type ? IdentitifyType[this.selected_identity_type.toUpperCase()] : undefined;
    }

    set_identity(type: IdentitifyType, identity: Identity) {
        this.identities[IdentitifyType[type].toLowerCase()] = identity;
    }

    spawn_identity_handshake_handler?(connection: AbstractServerConnection): HandshakeIdentityHandler {
        const identity = this.selected_identity();
        if (!identity)
            return undefined;
        return identity.spawn_identity_handshake_handler(connection);
    }

    encode?(): string {
        const identity_data = {};
        for (const key in this.identities)
            if (this.identities[key])
                identity_data[key] = this.identities[key].encode();

        return JSON.stringify({
            version: 1,
            username: this.default_username,
            password: this.default_password,
            profile_name: this.profile_name,
            identity_type: this.selected_identity_type,
            identity_data: identity_data,
            id: this.id
        });
    }

    valid(): boolean {
        const identity = this.selected_identity();

        return !!identity && identity.valid();
    }
}

async function decode_profile(data): Promise<ConnectionProfile | string> {
    data = JSON.parse(data);
    if (data.version !== 1)
        return "invalid version";

    const result: ConnectionProfile = new ConnectionProfile(data.id);
    result.default_username = data.username;
    result.default_password = data.password;
    result.profile_name = data.profile_name;
    result.selected_identity_type = (data.identity_type || "").toLowerCase();

    if (data.identity_data) {
        for (const key of Object.keys(data.identity_data)) {
            const type = IdentitifyType[key.toUpperCase() as string];
            const _data = data.identity_data[key];
            if (type == undefined) continue;

            const identity = await decode_identity(type, _data);
            if (identity == undefined) continue;

            result.identities[key.toLowerCase()] = identity;
        }
    }

    return result;
}

interface ProfilesData {
    version: number;
    profiles: string[];
}

let available_profiles: ConnectionProfile[] = [];

export async function load() {
    available_profiles = [];

    const profiles_json = localStorage.getItem("profiles");
    let profiles_data: ProfilesData = (() => {
        try {
            return profiles_json ? JSON.parse(profiles_json) : {version: 0} as any;
        } catch (error) {
            debugger;
            console.error(tr("Invalid profile json! Resetting profiles :( (%o)"), profiles_json);
            createErrorModal(tr("Profile data invalid"), formatMessage(tr("The profile data is invalid.{:br:}This might cause data loss."))).open();
            return {version: 0};
        }
    })();

    if (profiles_data.version === 0) {
        profiles_data = {
            version: 1,
            profiles: []
        };
    }
    if (profiles_data.version == 1) {
        for (const profile_data of profiles_data.profiles) {
            const profile = await decode_profile(profile_data);
            if (typeof profile === "string") {
                console.error(tr("Failed to load profile. Reason: %s, Profile data: %s"), profile, profiles_data);
            } else {
                available_profiles.push(profile as ConnectionProfile);
            }
        }
    }

    if (!find_profile("default")) { //Create a default profile and teaforo profile
        {
            const profile = create_new_profile("default", "default");
            profile.default_password = "";
            profile.default_username = "";
            profile.profile_name = "Default Profile";

            /* generate default identity */
            try {
                const identity = await TeaSpeakIdentity.generate_new();
                let active = true;
                setTimeout(() => {
                    active = false;
                }, 1000);
                await identity.improve_level(8, 1, () => active);
                profile.set_identity(IdentitifyType.TEAMSPEAK, identity);
                profile.selected_identity_type = IdentitifyType[IdentitifyType.TEAMSPEAK];
            } catch (error) {
                createErrorModal(tr("Failed to generate default identity"), tr("Failed to generate default identity!<br>Please manually generate the identity within your settings => profiles")).open();
            }
        }

        { /* forum identity (works only when connected to the forum) */
            const profile = create_new_profile("TeaSpeak Forum", "teaforo");
            profile.default_password = "";
            profile.default_username = "";
            profile.profile_name = "TeaSpeak Forum profile";

            profile.set_identity(IdentitifyType.TEAFORO, TeaForumIdentity.identity());
            profile.selected_identity_type = IdentitifyType[IdentitifyType.TEAFORO];
        }

        save();
    }
}

export function create_new_profile(name: string, id?: string): ConnectionProfile {
    const profile = new ConnectionProfile(id || guid());
    profile.profile_name = name;
    profile.default_username = "";
    available_profiles.push(profile);
    return profile;
}

let _requires_save = false;

export function save() {
    const profiles: string[] = [];
    for (const profile of available_profiles)
        profiles.push(profile.encode());

    const data = JSON.stringify({
        version: 1,
        profiles: profiles
    });
    localStorage.setItem("profiles", data);
}

export function mark_need_save() {
    _requires_save = true;
}

export function requires_save(): boolean {
    return _requires_save;
}

export function profiles(): ConnectionProfile[] {
    return available_profiles;
}

export function find_profile(id: string): ConnectionProfile | undefined {
    for (const profile of profiles())
        if (profile.id == id)
            return profile;

    return undefined;
}

export function find_profile_by_name(name: string): ConnectionProfile | undefined {
    name = name.toLowerCase();
    for (const profile of profiles())
        if ((profile.profile_name || "").toLowerCase() == name)
            return profile;

    return undefined;
}


export function default_profile(): ConnectionProfile {
    return find_profile("default");
}

export function set_default_profile(profile: ConnectionProfile) {
    const old_default = default_profile();
    if (old_default && old_default != profile) {
        old_default.id = guid();
    }
    profile.id = "default";
    return old_default;
}

export function delete_profile(profile: ConnectionProfile) {
    available_profiles.remove(profile);
}

window.addEventListener("beforeunload", event => {
    if(requires_save())
        save();
});