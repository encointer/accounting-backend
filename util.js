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


export function mapRescueCids(cid, blockNumber) {
    if(cid !== 'u0qj944rhWE') return cid
    let newCid = 'u0qj944rhWE'
    if(blockNumber < 1111286) newCid = 'u0qj9QqA2Q'
    if(blockNumber < 806355) newCid = 'u0qj92QX9PQ'
    return newCid
}

export function reduceObjects(objectsList) {
    // Use reduce to iterate over the objectsList
    return objectsList.reduce((result, currentObject) => {
      // Iterate over the keys of the currentObject
      Object.keys(currentObject).forEach(key => {
        // If the key is not in the result object, initialize it with the current value
        if (!result.hasOwnProperty(key)) {
          result[key] = currentObject[key];
        } else {
          // If the key is already present, add the current value to the existing value
          result[key] += currentObject[key];
        }
      });
      return result;
    }, {});
  }