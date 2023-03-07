import base58 from "bs58";

export function getMonthName(idx) {
    const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
    ];
    return monthNames[idx];
}

export function parseCid(cid) {
    return {
        geohash: cid.substring(0, 5),
        digest:
            "0x" +
            Buffer.from(base58.decode(cid.substring(5, 11))).toString("hex"),
    };
}

export function getRandomPassword() {
    var chars =
        "0123456789abcdefghijklmnopqrstuvwxyz!@#$%^&*()ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    var passwordLength = 12;
    var password = "";
    for (var i = 0; i <= passwordLength; i++) {
        var randomNumber = Math.floor(Math.random() * chars.length);
        password += chars.substring(randomNumber, randomNumber + 1);
    }
    return password;
}
