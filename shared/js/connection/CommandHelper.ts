import {ServerCommand, SingleCommandHandler} from "tc-shared/connection/ConnectionBase";
import * as log from "tc-shared/log";
import {LogCategory} from "tc-shared/log";
import {
    ClientNameInfo,
    CommandResult,
    Playlist, PlaylistInfo, PlaylistSong,
    QueryList,
    QueryListEntry, ServerGroupClient
} from "tc-shared/connection/ServerConnectionDeclaration";
import {ChannelEntry} from "tc-shared/ui/channel";
import {AbstractCommandHandler} from "tc-shared/connection/AbstractCommandHandler";
import {tr} from "tc-shared/i18n/localize";
import {ErrorCode} from "tc-shared/connection/ErrorCode";

export class CommandHelper extends AbstractCommandHandler {
    private _who_am_i: any;
    private infoByUniqueIdRequest: {[unique_id: string]:((resolved: ClientNameInfo) => any)[]} = {};
    private infoByDatabaseIdRequest: {[database_id: number]:((resolved: ClientNameInfo) => any)[]} = {};

    constructor(connection) {
        super(connection);

        this.volatile_handler_boss = false;
        this.ignore_consumed = true;
    }

    initialize() {
        this.connection.command_handler_boss().register_handler(this);
    }

    destroy() {
        if(this.connection) {
            const hboss = this.connection.command_handler_boss();
            hboss && hboss.unregister_handler(this);
        }
        this.infoByUniqueIdRequest = undefined;
    }

    handle_command(command: ServerCommand): boolean {
        if(command.command == "notifyclientnamefromuid")
            this.handle_notifyclientnamefromuid(command.arguments);
        if(command.command == "notifyclientgetnamefromdbid")
            this.handle_notifyclientgetnamefromdbid(command.arguments);
        else
            return false;
        return true;
    }

    joinChannel(channel: ChannelEntry, password?: string) : Promise<CommandResult> {
        return this.connection.send_command("clientmove", {
            "clid": this.connection.client.getClientId(),
            "cid": channel.getChannelId(),
            "cpw": password || ""
        });
    }

    async info_from_uid(..._unique_ids: string[]) : Promise<ClientNameInfo[]> {
        const response: ClientNameInfo[] = [];
        const request = [];
        const unique_ids = new Set(_unique_ids);
        if(!unique_ids.size) return [];

        const unique_id_resolvers: {[unique_id: string]: (resolved: ClientNameInfo) => any} = {};


        for(const unique_id of unique_ids) {
            request.push({'cluid': unique_id});
            (this.infoByUniqueIdRequest[unique_id] || (this.infoByUniqueIdRequest[unique_id] = []))
                .push(unique_id_resolvers[unique_id] = info => response.push(info));
        }

        try {
            await this.connection.send_command("clientgetnamefromuid", request);
        } catch(error) {
            if(error instanceof CommandResult && error.id == ErrorCode.DATABASE_EMPTY_RESULT) {
                /* nothing */
            } else {
                throw error;
            }
        } finally {
            /* cleanup */
            for(const unique_id of Object.keys(unique_id_resolvers))
                (this.infoByUniqueIdRequest[unique_id] || []).remove(unique_id_resolvers[unique_id]);
        }

        return response;
    }

    private handle_notifyclientgetnamefromdbid(json: any[]) {
        for(const entry of json) {
            const info: ClientNameInfo = {
                client_unique_id: entry["cluid"],
                client_nickname: entry["clname"],
                client_database_id: parseInt(entry["cldbid"])
            };

            const functions = this.infoByDatabaseIdRequest[info.client_database_id] || [];
            delete this.infoByDatabaseIdRequest[info.client_database_id];

            for(const fn of functions)
                fn(info);
        }
    }

    async info_from_cldbid(..._cldbid: number[]) : Promise<ClientNameInfo[]> {
        const response: ClientNameInfo[] = [];
        const request = [];
        const unique_cldbid = new Set(_cldbid);
        if(!unique_cldbid.size) return [];

        const unique_cldbid_resolvers: {[dbid: number]: (resolved: ClientNameInfo) => any} = {};


        for(const cldbid of unique_cldbid) {
            request.push({'cldbid': cldbid});
            (this.infoByDatabaseIdRequest[cldbid] || (this.infoByDatabaseIdRequest[cldbid] = []))
                .push(unique_cldbid_resolvers[cldbid] = info => response.push(info));
        }

        try {
            await this.connection.send_command("clientgetnamefromdbid", request);
        } catch(error) {
            if(error instanceof CommandResult && error.id == ErrorCode.DATABASE_EMPTY_RESULT) {
                /* nothing */
            } else {
                throw error;
            }
        } finally {
            /* cleanup */
            for(const cldbid of Object.keys(unique_cldbid_resolvers))
                (this.infoByDatabaseIdRequest[cldbid] || []).remove(unique_cldbid_resolvers[cldbid]);
        }

        return response;
    }

    private handle_notifyclientnamefromuid(json: any[]) {
        for(const entry of json) {
            const info: ClientNameInfo = {
                client_unique_id: entry["cluid"],
                client_nickname: entry["clname"],
                client_database_id: parseInt(entry["cldbid"])
            };

            const functions = this.infoByUniqueIdRequest[entry["cluid"]] || [];
            delete this.infoByUniqueIdRequest[entry["cluid"]];

            for(const fn of functions)
                fn(info);
        }
    }

    request_query_list(server_id: number = undefined) : Promise<QueryList> {
        return new Promise<QueryList>((resolve, reject) => {
            const single_handler = {
                command: "notifyquerylist",
                function: command => {
                    const json = command.arguments;

                    const result = {} as QueryList;

                    result.flag_all = json[0]["flag_all"];
                    result.flag_own = json[0]["flag_own"];
                    result.queries = [];

                    for(const entry of json) {
                        const rentry = {} as QueryListEntry;
                        rentry.bounded_server = parseInt(entry["client_bound_server"]);
                        rentry.username = entry["client_login_name"];
                        rentry.unique_id = entry["client_unique_identifier"];

                        result.queries.push(rentry);
                    }

                    resolve(result);
                    return true;
                }
            };
            this.handler_boss.register_single_handler(single_handler);

            let data = {};
            if(server_id !== undefined)
                data["server_id"] = server_id;

            this.connection.send_command("querylist", data).catch(error => {
                this.handler_boss.remove_single_handler(single_handler);

                if(error instanceof CommandResult) {
                    if(error.id == ErrorCode.DATABASE_EMPTY_RESULT) {
                        resolve(undefined);
                        return;
                    }
                }
                reject(error);
            });
        });
    }

    request_playlist_list() : Promise<Playlist[]> {
        return new Promise((resolve, reject) => {
            const single_handler: SingleCommandHandler = {
                command: "notifyplaylistlist",
                function: command => {
                    const json = command.arguments;
                    const result: Playlist[] = [];

                    for(const entry of json) {
                        try {
                            result.push({
                                playlist_id: parseInt(entry["playlist_id"]),
                                playlist_bot_id: parseInt(entry["playlist_bot_id"]),
                                playlist_title: entry["playlist_title"],
                                playlist_type: parseInt(entry["playlist_type"]),
                                playlist_owner_dbid: parseInt(entry["playlist_owner_dbid"]),
                                playlist_owner_name: entry["playlist_owner_name"],

                                needed_power_modify: parseInt(entry["needed_power_modify"]),
                                needed_power_permission_modify: parseInt(entry["needed_power_permission_modify"]),
                                needed_power_delete: parseInt(entry["needed_power_delete"]),
                                needed_power_song_add: parseInt(entry["needed_power_song_add"]),
                                needed_power_song_move: parseInt(entry["needed_power_song_move"]),
                                needed_power_song_remove: parseInt(entry["needed_power_song_remove"])
                            });
                        } catch(error) {
                            log.error(LogCategory.NETWORKING, tr("Failed to parse playlist entry: %o"), error);
                        }
                    }

                    resolve(result);
                    return true;
                }
            };
            this.handler_boss.register_single_handler(single_handler);

            this.connection.send_command("playlistlist").catch(error => {
                this.handler_boss.remove_single_handler(single_handler);

                if(error instanceof CommandResult) {
                    if(error.id == ErrorCode.DATABASE_EMPTY_RESULT) {
                        resolve([]);
                        return;
                    }
                }
                reject(error);
            })
        });
    }

    request_playlist_songs(playlist_id: number, process_result?: boolean) : Promise<PlaylistSong[]> {
        let bulked_response = false;
        let bulk_index = 0;

        const result: PlaylistSong[] = [];
        return new Promise((resolve, reject) => {
            const single_handler: SingleCommandHandler = {
                command: ["notifyplaylistsonglist", "notifyplaylistsonglistfinished"],
                function: command => {
                    const json = command.arguments;

                    if(bulk_index === 0) {
                        /* we're sending the response as bulk */
                        bulked_response = parseInt(json[0]["version"]) >= 2;
                    }

                    if(parseInt(json[0]["playlist_id"]) !== playlist_id)
                        return false; /* not our request */

                    if(command.command === "notifyplaylistsonglistfinished") {
                        resolve(result);
                        return true;
                    } else {
                        for(const entry of json) {
                            try {
                                result.push({
                                    song_id: parseInt(entry["song_id"]),
                                    song_invoker: entry["song_invoker"],
                                    song_previous_song_id: parseInt(entry["song_previous_song_id"]),
                                    song_url: entry["song_url"],
                                    song_url_loader: entry["song_url_loader"],

                                    song_loaded: entry["song_loaded"] == true || entry["song_loaded"] == "1",
                                    song_metadata: entry["song_metadata"]
                                });
                            } catch(error) {
                                log.error(LogCategory.NETWORKING, tr("Failed to parse playlist song entry: %o"), error);
                            }
                        }

                        if(bulked_response) {
                            bulk_index++;
                            return false;
                        } else {
                            resolve(result);
                            return true;
                        }
                    }
                }
            };
            this.handler_boss.register_single_handler(single_handler);

            this.connection.send_command("playlistsonglist", {playlist_id: playlist_id}, { process_result: process_result }).catch(error => {
                this.handler_boss.remove_single_handler(single_handler);
                if(error instanceof CommandResult) {
                    if(error.id == ErrorCode.DATABASE_EMPTY_RESULT) {
                        resolve([]);
                        return;
                    }
                }
                reject(error);
            })
        });
    }

    request_playlist_client_list(playlist_id: number) : Promise<number[]> {
        return new Promise((resolve, reject) => {
            const single_handler: SingleCommandHandler = {
                command: "notifyplaylistclientlist",
                function: command => {
                    const json = command.arguments;

                    if(json[0]["playlist_id"] != playlist_id) {
                        log.error(LogCategory.NETWORKING, tr("Received invalid notification for playlist clients"));
                        return false;
                    }

                    const result: number[] = [];

                    for(const entry of json)
                        result.push(parseInt(entry["cldbid"]));

                    resolve(result.filter(e => !isNaN(e)));
                    return true;
                }
            };
            this.handler_boss.register_single_handler(single_handler);

            this.connection.send_command("playlistclientlist", {playlist_id: playlist_id}).catch(error => {
                this.handler_boss.remove_single_handler(single_handler);
                if(error instanceof CommandResult && error.id == ErrorCode.DATABASE_EMPTY_RESULT) {
                    resolve([]);
                    return;
                }
                reject(error);
            })
        });
    }

    request_clients_by_server_group(group_id: number) : Promise<ServerGroupClient[]> {
        //servergroupclientlist sgid=2
        //notifyservergroupclientlist sgid=6 cldbid=2 client_nickname=WolverinDEV client_unique_identifier=xxjnc14LmvTk+Lyrm8OOeo4tOqw=
        return new Promise<ServerGroupClient[]>((resolve, reject) => {
            const single_handler: SingleCommandHandler = {
                command: "notifyservergroupclientlist",
                function: command => {
                    if (command.arguments[0]["sgid"] != group_id) {
                        log.error(LogCategory.NETWORKING, tr("Received invalid notification for server group client list"));
                        return false;
                    }

                    try {
                        const result: ServerGroupClient[] = [];
                        for(const entry of command.arguments) {
                            if(!('cldbid' in entry))
                                continue;
                            result.push({
                                client_database_id: parseInt(entry["cldbid"]),
                                client_nickname: entry["client_nickname"],
                                client_unique_identifier: entry["client_unique_identifier"]
                            });
                        }
                        resolve(result);
                    } catch (error) {
                        log.error(LogCategory.NETWORKING, tr("Failed to parse server group client list: %o"), error);
                        reject("failed to parse info");
                    }

                    return true;
                }
            };
            this.handler_boss.register_single_handler(single_handler);

            this.connection.send_command("servergroupclientlist", {sgid: group_id}).catch(error => {
                this.handler_boss.remove_single_handler(single_handler);
                reject(error);
            })
        });
    }

    request_playlist_info(playlist_id: number) : Promise<PlaylistInfo> {
        return new Promise((resolve, reject) => {
            const single_handler: SingleCommandHandler = {
                command: "notifyplaylistinfo",
                function: command => {
                    const json = command.arguments[0];
                    if (json["playlist_id"] != playlist_id) {
                        log.error(LogCategory.NETWORKING, tr("Received invalid notification for playlist info"));
                        return;
                    }

                    try {
                        //resolve
                        resolve({
                            playlist_id: parseInt(json["playlist_id"]),
                            playlist_title: json["playlist_title"],
                            playlist_description: json["playlist_description"],
                            playlist_type: parseInt(json["playlist_type"]),

                            playlist_owner_dbid: parseInt(json["playlist_owner_dbid"]),
                            playlist_owner_name: json["playlist_owner_name"],

                            playlist_flag_delete_played: json["playlist_flag_delete_played"] == true || json["playlist_flag_delete_played"] == "1",
                            playlist_flag_finished: json["playlist_flag_finished"] == true || json["playlist_flag_finished"] == "1",
                            playlist_replay_mode: parseInt(json["playlist_replay_mode"]),
                            playlist_current_song_id: parseInt(json["playlist_current_song_id"]),

                            playlist_max_songs: parseInt(json["playlist_max_songs"])
                        });
                    } catch (error) {
                        log.error(LogCategory.NETWORKING, tr("Failed to parse playlist info: %o"), error);
                        reject("failed to parse info");
                    }

                    return true;
                }
            };
            this.handler_boss.register_single_handler(single_handler);

            this.connection.send_command("playlistinfo", {playlist_id: playlist_id}).catch(error => {
                this.handler_boss.remove_single_handler(single_handler);
                reject(error);
            })
        });
    }

    /**
     * @deprecated
     *  Its just a workaround for the query management.
     *  There is no garantee that the whoami trick will work forever
     */
    current_virtual_server_id() : Promise<number> {
        if(this._who_am_i)
            return Promise.resolve(parseInt(this._who_am_i["virtualserver_id"]));

        return new Promise<number>((resolve, reject) => {
            const single_handler: SingleCommandHandler = {
                function: command => {
                    if(command.command != "" && command.command.indexOf("=") == -1)
                        return false;

                    this._who_am_i = command.arguments[0];
                    resolve(parseInt(this._who_am_i["virtualserver_id"]));
                    return true;
                }
            };
            this.handler_boss.register_single_handler(single_handler);

            this.connection.send_command("whoami").catch(error => {
                this.handler_boss.remove_single_handler(single_handler);
                reject(error);
            });
        });
    }
}